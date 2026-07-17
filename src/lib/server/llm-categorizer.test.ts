import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import { LlmUnavailable, type Llm, type LlmRequest } from './llm';
import {
	buildCategorizerPrompt,
	loadLlmTaxonomy,
	parseAssignments,
	runLlmCategorization,
	type LlmCharge
} from './llm-categorizer';
import { recategorizeAll } from './categorize-db';

function makeDb() {
	const db = new Database(':memory:');
	migrate(db);
	db.prepare("INSERT INTO connections (institution_name, plaid_item_id) VALUES ('B', 'i')").run();
	db.prepare(
		"INSERT INTO accounts (connection_id, plaid_account_id, name, type) VALUES (1, 'a', 'Checking', 'depository')"
	).run();
	return db;
}

function cat(db: Database.Database, name: string): number {
	return db.prepare('SELECT id FROM categories WHERE name = ?').pluck().get(name) as number;
}

function insertTxn(
	db: Database.Database,
	pid: string,
	source: 'plaid' | 'rule' | 'correction' | 'llm',
	over: Record<string, unknown> = {}
): number {
	const row = {
		merchant: 'Blue Bottle',
		name: 'SQ *BLUE BOTTLE #12',
		amount_cents: -450,
		category: 'Other',
		is_transfer: 0,
		is_investment_activity: 0,
		receipt_facts_json: null,
		...over
	};
	return db
		.prepare(
			`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, merchant, amount_cents,
			   category_id, category_source, plaid_category_primary, plaid_category_detailed, plaid_confidence,
			   payment_channel, is_transfer, is_investment_activity, receipt_facts_json)
			 VALUES (1, ?, '2026-06-01', ?, ?, ?, ?, ?, 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_COFFEE', 'HIGH',
			   'in store', ?, ?, ?) RETURNING id`
		)
		.pluck()
		.get(
			pid,
			row.name,
			row.merchant,
			row.amount_cents,
			cat(db, row.category as string),
			source,
			row.is_transfer,
			row.is_investment_activity,
			row.receipt_facts_json
		) as number;
}

function txnState(db: Database.Database, id: number) {
	return db
		.prepare(
			`SELECT c.name AS category, t.category_source AS source
			 FROM transactions t JOIN categories c ON c.id = t.category_id WHERE t.id = ?`
		)
		.get(id) as { category: string; source: string };
}

/** Canned Llm: records requests, serves the given replies in order. */
function cannedLlm(replies: (string | Error)[], log: LlmRequest[] = []): Llm {
	let i = 0;
	return async (req) => {
		log.push(req);
		const next = replies[i++];
		if (next instanceof Error) throw next;
		return next;
	};
}

const CHARGE: LlmCharge = {
	id: 1,
	name: 'SQ *BLUE BOTTLE #12',
	merchant: 'Blue Bottle',
	amount_cents: -450,
	date: '2026-06-01',
	pfc_primary: 'FOOD_AND_DRINK',
	pfc_detailed: 'FOOD_AND_DRINK_COFFEE',
	pfc_confidence: 'HIGH',
	account_type: 'depository',
	payment_channel: 'in store'
};

// --- the egress boundary (story 26/27): exactly the scoped evidence, never Transfer ---

test('prompt carries the scoped evidence: raw + normalized merchant, amount, date, Plaid hints, account type, channel', () => {
	const db = makeDb();
	const prompt = buildCategorizerPrompt([CHARGE], loadLlmTaxonomy(db));

	expect(prompt).toContain('SQ *BLUE BOTTLE #12');
	expect(prompt).toContain('Blue Bottle');
	expect(prompt).toContain('$4.50 out on 2026-06-01');
	expect(prompt).toContain('FOOD_AND_DRINK / FOOD_AND_DRINK_COFFEE (HIGH)');
	expect(prompt).toContain('account: depository');
	expect(prompt).toContain('channel: in store');
});

test('taxonomy excludes Transfer and disabled Categories, groups under Group names', () => {
	const db = makeDb();
	db.prepare("UPDATE categories SET disabled = 1 WHERE name = 'Pets'").run();

	const taxonomy = loadLlmTaxonomy(db);
	const names = taxonomy.map((c) => c.name);
	expect(names).not.toContain('Transfer');
	expect(names).not.toContain('Pets');
	expect(names).toContain('Coffee');

	const prompt = buildCategorizerPrompt([CHARGE], taxonomy);
	expect(prompt).not.toContain('Transfer');
	expect(prompt).not.toContain('Pets');
	expect(prompt).toContain('Food & Dining:');
});

// --- strict parse ---

test('parse accepts valid output and matches names case-insensitively', () => {
	const db = makeDb();
	const taxonomy = loadLlmTaxonomy(db);
	const charges = [CHARGE, { ...CHARGE, id: 2 }];

	const out = parseAssignments('{"1": "coffee", "2": "Groceries"}', charges, taxonomy);
	expect(out.get(1)).toBe(cat(db, 'Coffee'));
	expect(out.get(2)).toBe(cat(db, 'Groceries'));
});

test('unknown Categories and bad JSON are discarded per-charge, valid siblings survive', () => {
	const db = makeDb();
	const taxonomy = loadLlmTaxonomy(db);
	const charges = [CHARGE, { ...CHARGE, id: 2 }];

	const partial = parseAssignments('{"1": "Cryptocurrency", "2": "Dining"}', charges, taxonomy);
	expect(partial.has(1)).toBe(false);
	expect(partial.get(2)).toBe(cat(db, 'Dining'));

	expect(parseAssignments('not json at all', charges, taxonomy).size).toBe(0);
	expect(parseAssignments('{"1": 42}', charges, taxonomy).size).toBe(0);
});

test('parse strips code fences (same tolerance as the proposer)', () => {
	const db = makeDb();
	const out = parseAssignments('```json\n{"1": "Coffee"}\n```', [CHARGE], loadLlmTaxonomy(db));
	expect(out.get(1)).toBe(cat(db, 'Coffee'));
});

// --- the ladder (stories 23–25, 27–28) ---

test('llm beats plaid; rule and correction rows are never sent or touched', async () => {
	const db = makeDb();
	const plaidRow = insertTxn(db, 't-1', 'plaid');
	const ruleRow = insertTxn(db, 't-2', 'rule', { category: 'Dining' });
	const corrRow = insertTxn(db, 't-3', 'correction', { category: 'Gifts' });

	const log: LlmRequest[] = [];
	await runLlmCategorization(db, cannedLlm(['{"1": "Coffee"}'], log), [plaidRow, ruleRow, corrRow]);

	expect(txnState(db, plaidRow)).toEqual({ category: 'Coffee', source: 'llm' });
	expect(txnState(db, ruleRow)).toEqual({ category: 'Dining', source: 'rule' });
	expect(txnState(db, corrRow)).toEqual({ category: 'Gifts', source: 'correction' });
	expect(log).toHaveLength(1); // one batched call, only the plaid row in it
	expect(log[0].prompt.match(/^\d+\. /gm)).toHaveLength(1);
});

test('transfer legs and investment activity never reach the model', async () => {
	const db = makeDb();
	const transfer = insertTxn(db, 't-1', 'plaid', { is_transfer: 1 });
	const invest = insertTxn(db, 't-2', 'plaid', { is_investment_activity: 1 });

	const log: LlmRequest[] = [];
	await runLlmCategorization(db, cannedLlm(['{}'], log), [transfer, invest]);

	expect(log).toHaveLength(0); // nothing to send → no call at all
	expect(txnState(db, transfer).source).toBe('plaid');
});

test('LLM unavailable → fail-soft: rows keep their Plaid-map Category (story 28)', async () => {
	const db = makeDb();
	const id = insertTxn(db, 't-1', 'plaid');

	await runLlmCategorization(db, cannedLlm([new LlmUnavailable('no key')]), [id]);

	expect(txnState(db, id)).toEqual({ category: 'Other', source: 'plaid' });
});

test('an out-of-taxonomy answer leaves that charge on the Plaid rung', async () => {
	const db = makeDb();
	const good = insertTxn(db, 't-1', 'plaid');
	const bad = insertTxn(db, 't-2', 'plaid');

	await runLlmCategorization(db, cannedLlm(['{"1": "Coffee", "2": "Transfer"}']), [good, bad]);

	expect(txnState(db, good)).toEqual({ category: 'Coffee', source: 'llm' });
	expect(txnState(db, bad)).toEqual({ category: 'Other', source: 'plaid' }); // Transfer never assignable
});

test('the model is asked for the configured proposer model', async () => {
	const db = makeDb();
	db.prepare("INSERT INTO settings (key, value) VALUES ('proposer_model', 'claude-haiku-9')").run();
	const id = insertTxn(db, 't-1', 'plaid');

	const log: LlmRequest[] = [];
	await runLlmCategorization(db, cannedLlm(['{"1": "Coffee"}'], log), [id]);

	expect(log[0].model).toBe('claude-haiku-9');
});

// --- the unified categorizer: Receipt facts join the evidence when present ---

const FACTS = JSON.stringify({
	description: 'AirPods Pro (2nd gen)',
	vendor: 'Apple',
	items: [{ name: 'AirPods Pro (2nd gen)', price_cents: 24900 }]
});

test('a row with Receipt facts sends them to the model and lands as llm+receipt', async () => {
	const db = makeDb();
	const bare = insertTxn(db, 't-1', 'plaid');
	const enriched = insertTxn(db, 't-2', 'plaid', { receipt_facts_json: FACTS });

	const log: LlmRequest[] = [];
	await runLlmCategorization(db, cannedLlm(['{"1": "Coffee", "2": "Entertainment"}'], log), [bare, enriched]);

	expect(log[0].prompt).toContain('AirPods Pro (2nd gen)');
	expect(log[0].prompt).toContain('Apple');
	expect(txnState(db, bare)).toEqual({ category: 'Coffee', source: 'llm' });
	expect(txnState(db, enriched)).toEqual({ category: 'Entertainment', source: 'llm+receipt' });
});

test('re-run on Receipt match replaces a model or Plaid assignment; Rules and Corrections hold', async () => {
	const db = makeDb();
	const llmRow = insertTxn(db, 't-1', 'llm', { category: 'Shopping', receipt_facts_json: FACTS });
	const ruleRow = insertTxn(db, 't-2', 'rule', { category: 'Dining', receipt_facts_json: FACTS });

	await runLlmCategorization(db, cannedLlm(['{"1": "Entertainment"}']), [llmRow, ruleRow]);

	expect(txnState(db, llmRow)).toEqual({ category: 'Entertainment', source: 'llm+receipt' });
	expect(txnState(db, ruleRow)).toEqual({ category: 'Dining', source: 'rule' });
});

// --- sweeps stay deterministic and free (story 32) ---

test('recategorizeAll respects llm and llm+receipt rows and never calls a model', async () => {
	const db = makeDb();
	const id = insertTxn(db, 't-1', 'plaid');
	const enriched = insertTxn(db, 't-2', 'plaid', { receipt_facts_json: FACTS });
	await runLlmCategorization(db, cannedLlm(['{"1": "Coffee", "2": "Entertainment"}']), [id, enriched]);

	// a new Rule for this merchant would re-point plaid rows — model rows hold
	db.prepare('INSERT INTO rules (merchant, category_id) VALUES (?, ?)').run(
		'Blue Bottle',
		cat(db, 'Dining')
	);
	recategorizeAll(db);

	expect(txnState(db, id)).toEqual({ category: 'Coffee', source: 'llm' });
	expect(txnState(db, enriched)).toEqual({ category: 'Entertainment', source: 'llm+receipt' });
});

// ---------- malformed receipt facts never abort a batch (#14) ----------

test('a malformed receipt_facts_json row drops its receipt line, keeps the batch alive', () => {
	const taxonomy: { id: number; name: string; group: string }[] = [
		{ id: 1, name: 'Coffee', group: 'Food' }
	];
	const charges: LlmCharge[] = [
		{
			id: 1, name: 'A', merchant: 'A', amount_cents: -100, date: '2026-06-01',
			pfc_primary: null, pfc_detailed: null, pfc_confidence: null,
			account_type: 'depository', payment_channel: null,
			receipt_facts_json: 'not json {'
		},
		{
			id: 2, name: 'B', merchant: 'B', amount_cents: -200, date: '2026-06-01',
			pfc_primary: null, pfc_detailed: null, pfc_confidence: null,
			account_type: 'depository', payment_channel: null,
			receipt_facts_json: '{"description": "ok", "items": "not-an-array"}'
		},
		{
			id: 3, name: 'C', merchant: 'C', amount_cents: -300, date: '2026-06-01',
			pfc_primary: null, pfc_detailed: null, pfc_confidence: null,
			account_type: 'depository', payment_channel: null,
			receipt_facts_json: '{"description": "Latte", "vendor": "Cafe", "items": [{"name": "Latte"}]}'
		}
	];
	const prompt = buildCategorizerPrompt(charges, taxonomy);
	expect(prompt).toContain('merchant "A"'); // malformed row still listed, minus receipt line
	expect(prompt).toContain('receipt: ok'); // bad items ignored, description survives
	expect(prompt).toContain('receipt: Latte (vendor: Cafe); items: Latte');
});

test('runLlmCategorization survives a malformed receipt_facts_json row end to end', async () => {
	const db = makeDb();
	const id = insertTxn(db, 'bad-facts', 'plaid', { receipt_facts_json: '{broken' });
	const replies: string[] = [`{"1": "Coffee"}`];
	let i = 0;
	const llm: Llm = async () => replies[i++];
	await runLlmCategorization(db, llm, [id]);
	const row = db
		.prepare('SELECT category_source AS s FROM transactions WHERE id = ?')
		.get(id) as { s: string };
	expect(row.s).toBe('llm'); // categorized on bank evidence alone — the broken blob sent nothing
});
