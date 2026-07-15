import type { Database } from 'better-sqlite3';
import { ReceiptSearchUnavailable, type ChargeFacts, type ReceiptSource } from './gmail';
import { matchReceipt, type MatchOptions } from './matcher';
import type { Llm } from './llm';
import { enrichTransaction } from './receipt-extractor';
import { runLlmCategorization } from './llm-categorizer';

// Post-sync receipt resolution (PRD resolution module, rewired by the
// enrich-then-categorize PRD): every new Unresolved charge gets one narrow
// Gmail search per sync until it either matches or ages past the retry window.
// State lives on the Transaction row:
//   NULL → pending (searched, nothing yet) → matched | exhausted
// A match then flows through Layer 1 (extract Receipt facts onto the row) and
// Layer 2 (the unified categorizer re-runs on that one Transaction).

export function receiptWindowDays(db: Database): number {
	return knob(db, 'receipt_retry_window_days', 14);
}

function matchOptions(db: Database): MatchOptions {
	return {
		windowDays: receiptWindowDays(db),
		minScore: knob(db, 'receipt_match_min_score', 4)
	};
}

function knob(db: Database, key: string, fallback: number): number {
	const raw = db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as
		| string
		| undefined;
	const n = Number(raw);
	return Number.isFinite(n) && raw !== undefined ? n : fallback;
}

type ChargeRow = {
	id: number;
	date: string;
	amount_cents: number;
	merchant: string | null;
	name: string;
};

/**
 * The post-sync sweep. Charges already older than the window exhaust
 * unsearched. Returns the ids that matched on this pass so the caller can
 * enrich and re-categorize exactly those — never the whole matched backlog.
 */
export async function runReceiptSearch(
	db: Database,
	source: ReceiptSource,
	today: string = new Date().toISOString().slice(0, 10)
): Promise<number[]> {
	const opts = matchOptions(db);
	const charges = db
		.prepare(
			`SELECT id, date, amount_cents, merchant, name FROM transactions
			 WHERE unresolved = 1 AND pending = 0 AND is_transfer = 0 AND is_investment_activity = 0
			   AND (receipt_search_state IS NULL OR receipt_search_state = 'pending')
			 ORDER BY date DESC`
		)
		.all() as ChargeRow[];
	const matched: number[] = [];
	for (const charge of charges) {
		if (ageDays(charge.date, today) > opts.windowDays) {
			setState(db, charge.id, 'exhausted');
		} else if ((await searchOne(db, source, charge, opts, today)) === 'matched') {
			matched.push(charge.id);
		}
	}
	return matched;
}

/**
 * Manual lookup on ANY Transaction (story 17) — ignores the age gate and
 * resets whatever state was there. No match on an aged charge → exhausted;
 * a young charge stays pending so the sync sweep keeps retrying.
 */
export async function triggerLookup(
	db: Database,
	source: ReceiptSource,
	txnId: number,
	today: string = new Date().toISOString().slice(0, 10)
): Promise<SearchOutcome> {
	const charge = db
		.prepare('SELECT id, date, amount_cents, merchant, name FROM transactions WHERE id = ?')
		.get(txnId) as ChargeRow | undefined;
	if (!charge) throw new Error(`no Transaction ${txnId}`);
	return searchOne(db, source, charge, matchOptions(db), today);
}

// 'matched' = fresh hit (callers enrich + re-categorize); 'retained' = a prior
// match kept because this pass found nothing new (callers must NOT re-enrich —
// that would burn an LLM call and can null good facts on a flaky reply);
// 'unsearched' = no inbox answered, state left untouched.
export type SearchOutcome = 'matched' | 'retained' | 'pending' | 'exhausted' | 'unsearched';

async function searchOne(
	db: Database,
	source: ReceiptSource,
	charge: ChargeRow,
	opts: MatchOptions,
	today: string
): Promise<SearchOutcome> {
	const facts: ChargeFacts = {
		amount_cents: charge.amount_cents,
		date: charge.date,
		merchant: charge.merchant ?? charge.name
	};
	let candidates;
	try {
		candidates = await source.searchReceipts(facts);
	} catch (e) {
		// no inbox actually answered — leave state and any stored match untouched
		// rather than falsely downgrading/exhausting a charge over a dead connection (#05)
		if (e instanceof ReceiptSearchUnavailable) return 'unsearched';
		throw e;
	}
	const match = matchReceipt(facts, candidates, opts);
	if (match) {
		try {
			// body is bonus evidence for the extractor — a failed fetch never voids the match
			match.body = (await source.fetchBody?.(match.inboxAddress, match.messageId)) || undefined;
		} catch {
			match.body = undefined;
		}
		// clear stale facts so a fresh match never inherits facts extracted from a
		// different email (#41); the enrich pass repopulates them
		db.prepare(
			"UPDATE transactions SET receipt_search_state = 'matched', receipt_json = ?, receipt_facts_json = NULL WHERE id = ?"
		).run(JSON.stringify(match), charge.id);
		return 'matched';
	}
	// a re-lookup that finds nothing must not destroy a prior match's stored
	// evidence while its category still cites it (#42) — keep it, look again later.
	// 'retained' (not 'matched') so callers don't re-enrich an unchanged match.
	if (currentState(db, charge.id) === 'matched') return 'retained';
	const state = ageDays(charge.date, today) > opts.windowDays ? 'exhausted' : 'pending';
	setState(db, charge.id, state);
	return state;
}

function currentState(db: Database, txnId: number): string | null {
	return db
		.prepare('SELECT receipt_search_state FROM transactions WHERE id = ?')
		.pluck()
		.get(txnId) as string | null;
}

function setState(db: Database, txnId: number, state: string): void {
	db.prepare(
		'UPDATE transactions SET receipt_search_state = ?, receipt_json = NULL, receipt_facts_json = NULL WHERE id = ?'
	).run(state, txnId);
}

function ageDays(chargeDate: string, today: string): number {
	return (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${chargeDate}T00:00:00Z`)) / 86_400_000;
}

// --- enrich then categorize: matched Receipt → facts on the row → re-run ---

/**
 * Layer 1 + Layer 2 for freshly matched Transactions: extract Receipt facts
 * onto each row, then hand them all to the unified categorizer in one batch.
 * Both layers fail soft (empty facts / unchanged Category) — a Gmail or API
 * outage never blocks the sync.
 */
export async function enrichAndCategorize(
	db: Database,
	llm: Llm,
	txnIds: readonly number[]
): Promise<void> {
	await enrichReceipts(db, llm, txnIds);
	await runLlmCategorization(db, llm, txnIds);
}

/**
 * Layer 1 only: Receipt facts onto the rows, Category untouched. The Settings
 * receipt scan uses this — evidence gathering and judging are separate buttons
 * there; the next categorization pass picks the facts up.
 */
export async function enrichReceipts(
	db: Database,
	llm: Llm,
	txnIds: readonly number[]
): Promise<void> {
	// ponytail: 5 concurrent extractor calls, same throttle as the search loop
	for (let i = 0; i < txnIds.length; i += 5) {
		await Promise.all(txnIds.slice(i, i + 5).map((id) => enrichTransaction(db, llm, id)));
	}
}

/** The full post-sync pipeline: search + match, then enrich + categorize the new matches. */
export async function runResolution(
	db: Database,
	source: ReceiptSource,
	llm: Llm,
	today?: string
): Promise<void> {
	await runReceiptSearch(db, source, today);
	// enrich every matched row still missing facts — fresh matches (searchOne
	// nulls facts) AND rows stranded by a prior LLM outage. receipt_json is
	// already stored, so this needs no Gmail call and self-heals #40 next sync.
	const pending = db
		.prepare(
			"SELECT id FROM transactions WHERE receipt_search_state = 'matched' AND receipt_facts_json IS NULL"
		)
		.pluck()
		.all() as number[];
	await enrichAndCategorize(db, llm, pending);
}
