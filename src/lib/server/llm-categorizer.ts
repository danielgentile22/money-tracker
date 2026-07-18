import type { Database } from 'better-sqlite3';
import { LlmUnavailable, modelSetting, type Llm } from './llm';
import type { ReceiptFacts } from './receipt-extractor';

// The unified LLM categorization rung (ADR-0007, amending ADR-0006; ladder:
// Rule → Correction → LLM → Plaid map → Other). One batched call per sync over
// that sync's new Transactions; one single-row re-run when a Receipt later
// matches. Sweeps after Rule/mapping edits never call the model.
//
// buildCategorizerPrompt is the ADR-0001 egress boundary: its inputs (the
// charge evidence below, extracted Receipt facts when a Receipt matched, plus
// the enabled taxonomy) are the only things that can reach the model — no
// account numbers, no balances, no identity, by construction. `Transfer` is
// never offered: the pairing pipeline stays the only authority on Transfers.

export type LlmCharge = {
	id: number;
	name: string; // raw bank string
	merchant: string; // normalized
	amount_cents: number;
	date: string;
	pfc_primary: string | null;
	pfc_detailed: string | null;
	pfc_confidence: string | null;
	account_type: string;
	payment_channel: string | null;
	receipt_facts_json?: string | null; // Layer-1 enrichment, when a Receipt matched
};

export type TaxonomyCategory = { id: number; name: string; group: string };

/** Enabled taxonomy grouped by Group, `Transfer` excluded (story 27). */
export function loadLlmTaxonomy(db: Database): TaxonomyCategory[] {
	return db
		.prepare(
			`SELECT c.id, c.name, g.name AS "group"
			 FROM categories c JOIN category_groups g ON g.id = c.group_id
			 WHERE c.disabled = 0 AND lower(c.name) != 'transfer'
			 ORDER BY g.sort_order, c.sort_order, c.id`
		)
		.all() as TaxonomyCategory[];
}

export function buildCategorizerPrompt(
	charges: readonly LlmCharge[],
	taxonomy: readonly TaxonomyCategory[]
): string {
	const groups = new Map<string, string[]>();
	for (const c of taxonomy) {
		if (!groups.has(c.group)) groups.set(c.group, []);
		groups.get(c.group)!.push(c.name);
	}
	const lines = charges.map((c, i) => {
		const amount = (Math.abs(c.amount_cents) / 100).toFixed(2);
		const dir = c.amount_cents < 0 ? 'out' : 'in';
		const plaid = c.pfc_primary
			? `, Plaid guess: ${c.pfc_primary}${c.pfc_detailed ? ` / ${c.pfc_detailed}` : ''}${c.pfc_confidence ? ` (${c.pfc_confidence})` : ''}`
			: '';
		const channel = c.payment_channel ? `, channel: ${c.payment_channel}` : '';
		return `${i + 1}. $${amount} ${dir} on ${c.date} — merchant "${c.merchant}" (raw "${c.name}"), account: ${c.account_type}${channel}${plaid}${receiptLine(c)}`;
	});
	return [
		'Categorize these bank charges. Judge only from the evidence given.',
		'',
		'Categories by group (assign each charge exactly one category name, verbatim):',
		...[...groups].map(([g, names]) => `${g}: ${names.join(', ')}`),
		'',
		'Charges:',
		...lines,
		'',
		'Reply with JSON only, no other text — one entry per charge number:',
		`{"1": "<category>", ..., "${charges.length}": "<category>"}`
	].join('\n');
}

/** The receipt evidence line: what the vendor's own email said the charge was for. */
/** #61: parsed facts, or null when the stored blob is malformed/unusable. */
function usableFacts(c: LlmCharge): ReceiptFacts | null {
	if (!c.receipt_facts_json) return null;
	let facts: ReceiptFacts;
	try {
		facts = JSON.parse(c.receipt_facts_json) as ReceiptFacts;
	} catch {
		return null;
	}
	return facts && typeof facts.description === 'string' ? facts : null;
}

function receiptLine(c: LlmCharge): string {
	// #61: one malformed row must not abort the whole categorization batch
	const facts = usableFacts(c);
	if (!facts) return '';
	const items = Array.isArray(facts.items)
		? facts.items.filter((it) => typeof it?.name === 'string').map((it) => it.name)
		: [];
	const itemsPart = items.length ? `; items: ${items.join(', ')}` : '';
	const vendor = facts.vendor ? ` (vendor: ${facts.vendor})` : '';
	return `\n   receipt: ${facts.description}${vendor}${itemsPart}`;
}

/**
 * Strict per-charge parse: only a clean, in-taxonomy answer assigns a
 * Category; anything else (bad JSON, unknown name, missing entry) leaves that
 * charge on its Plaid-map rung — the fallback is already applied.
 */
export function parseAssignments(
	reply: string,
	charges: readonly LlmCharge[],
	taxonomy: readonly TaxonomyCategory[]
): Map<number, number> {
	const out = new Map<number, number>(); // txn id → category id
	let parsed: unknown;
	try {
		parsed = JSON.parse(reply.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
	} catch {
		return out;
	}
	if (typeof parsed !== 'object' || parsed === null) return out;
	const byName = new Map(taxonomy.map((c) => [c.name.toLowerCase(), c.id]));
	for (const [key, value] of Object.entries(parsed)) {
		const charge = charges[Number(key) - 1];
		if (!charge || typeof value !== 'string') continue;
		const categoryId = byName.get(value.trim().toLowerCase());
		if (categoryId != null) out.set(charge.id, categoryId);
	}
	return out;
}

// ponytail: 100 charges per call — one call at household sync volume; the
// first-ever import (full history) just chunks. Raise if prompts stay small.
const BATCH = 100;

/**
 * Categorize Transactions with batched LLM calls (story 23), Receipt facts
 * included when the row has them. Only model-decidable rows are sent — Rules,
 * Corrections, and approved Proposals already won theirs — and transfer legs
 * and investment activity never go. A row with facts lands as 'llm+receipt',
 * bank evidence alone as 'llm', so every assignment names its evidence.
 * LLM unavailable → return quietly; rows keep their current Category.
 */
export async function runLlmCategorization(
	db: Database,
	llm: Llm,
	txnIds: readonly number[]
): Promise<void> {
	if (txnIds.length === 0) return;
	const taxonomy = loadLlmTaxonomy(db);
	const charges = db
		.prepare(
			`SELECT t.id, t.name, t.merchant, t.amount_cents, t.date,
			        t.plaid_category_primary AS pfc_primary, t.plaid_category_detailed AS pfc_detailed,
			        t.plaid_confidence AS pfc_confidence, a.type AS account_type, t.payment_channel,
			        t.receipt_facts_json
			 FROM transactions t JOIN accounts a ON a.id = t.account_id
			 WHERE t.id IN (SELECT value FROM json_each(?))
			   AND t.category_source IN ('plaid', 'llm', 'llm+receipt')
			   AND t.is_transfer = 0 AND t.is_excluded = 0 AND t.is_investment_activity = 0
			 ORDER BY t.id`
		)
		.all(JSON.stringify(txnIds)) as LlmCharge[];
	const model = modelSetting(db, 'proposer_model');
	const apply = db.prepare(
		'UPDATE transactions SET category_id = ?, category_source = ? WHERE id = ?'
	);
	for (let i = 0; i < charges.length; i += BATCH) {
		const batch = charges.slice(i, i + BATCH);
		let reply: string;
		try {
			reply = await llm({
				model,
				prompt: buildCategorizerPrompt(batch, taxonomy),
				maxTokens: 4000
			});
		} catch (e) {
			if (e instanceof LlmUnavailable) return; // fail-soft: current rung already applied
			throw e;
		}
		const assignments = parseAssignments(reply, batch, taxonomy);
		// provenance follows what the model actually saw: malformed facts sent no
		// receipt line, so the assignment is bank-evidence-only (codex review P2)
		const sourceOf = new Map(batch.map((c) => [c.id, usableFacts(c) ? 'llm+receipt' : 'llm']));
		db.transaction(() => {
			for (const [txnId, categoryId] of assignments)
				apply.run(categoryId, sourceOf.get(txnId), txnId);
		})();
	}
}
