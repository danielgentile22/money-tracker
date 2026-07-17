import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import { LlmUnavailable, type LlmRequest } from './llm';
import { buildExtractorPrompt, parseFacts, enrichTransaction, type ReceiptFacts } from './receipt-extractor';
import type { ReceiptCandidate } from './gmail';

const receipt = (over: Partial<ReceiptCandidate> = {}): ReceiptCandidate => ({
	inboxAddress: 'owner@gmail.com',
	messageId: 'm1',
	from: 'orders@apple.example.com',
	subject: 'Your receipt from Apple',
	date: '2026-07-01',
	snippet: 'AirPods Pro…',
	body: 'AirPods Pro (2nd gen) $249.00\nSubtotal $249.00',
	...over
});

// --- the egress boundary: headers + capped body, nothing else ---

test('prompt carries from, subject, date, and the body; snippet stands in when no body', () => {
	const prompt = buildExtractorPrompt(receipt());
	expect(prompt).toContain('orders@apple.example.com');
	expect(prompt).toContain('Your receipt from Apple');
	expect(prompt).toContain('2026-07-01');
	expect(prompt).toContain('AirPods Pro (2nd gen) $249.00');

	const noBody = buildExtractorPrompt(receipt({ body: undefined }));
	expect(noBody).toContain('AirPods Pro…');
});

// --- strict parse: clean reply → facts, anything else → null ---

test('clean reply parses to description, vendor, and line items with prices in cents', () => {
	const facts = parseFacts(
		'{"description": "AirPods Pro (2nd gen)", "vendor": "Apple", "items": [{"name": "AirPods Pro (2nd gen)", "price": 249}]}'
	);
	expect(facts).toEqual({
		description: 'AirPods Pro (2nd gen)',
		vendor: 'Apple',
		items: [{ name: 'AirPods Pro (2nd gen)', price_cents: 24900 }]
	});
});

test('items and vendor are optional; a priceless item keeps its name', () => {
	const facts = parseFacts('{"description": "Monthly iCloud storage"}');
	expect(facts).toEqual({ description: 'Monthly iCloud storage', vendor: null, items: [] });

	const mixed = parseFacts(
		'{"description": "Groceries", "items": [{"name": "Bananas"}, {"name": "Milk", "price": 3.5}]}'
	);
	expect(mixed?.items).toEqual([
		{ name: 'Bananas', price_cents: null },
		{ name: 'Milk', price_cents: 350 }
	]);
});

test('malformed, non-JSON, or descriptionless replies parse to null — never a guess', () => {
	expect(parseFacts('the purchase was AirPods')).toBeNull();
	expect(parseFacts('{"vendor": "Apple"}')).toBeNull();
	expect(parseFacts('{"description": 42}')).toBeNull();
	expect(parseFacts('```json\n{"description": "AirPods"}\n```')?.description).toBe('AirPods');
});

// --- enrichment writes onto the matched row ---

function makeDb() {
	const db = new Database(':memory:');
	migrate(db);
	db.prepare("INSERT INTO connections (institution_name, plaid_item_id) VALUES ('B', 'i')").run();
	db.prepare(
		"INSERT INTO accounts (connection_id, plaid_account_id, name, type) VALUES (1, 'a', 'Checking', 'depository')"
	).run();
	return db;
}

function insertMatched(db: Database.Database): number {
	return db
		.prepare(
			`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, merchant, amount_cents,
			   receipt_search_state, receipt_json)
			 VALUES (1, 'rx-1', '2026-07-01', 'APPLE.COM/BILL', 'Apple', -24900, 'matched', ?) RETURNING id`
		)
		.pluck()
		.get(JSON.stringify(receipt())) as number;
}

const rowOf = (db: Database.Database, id: number) =>
	db
		.prepare(
			'SELECT receipt_search_state AS s, receipt_json AS j, receipt_facts_json AS f FROM transactions WHERE id = ?'
		)
		.get(id) as { s: string | null; j: string | null; f: string | null };

function cannedLlm(replies: (string | Error)[], log: LlmRequest[] = []) {
	let i = 0;
	return async (req: LlmRequest) => {
		log.push(req);
		const next = replies[i++];
		if (next instanceof Error) throw next;
		return next;
	};
}

test('a clean extraction stores facts on the row', async () => {
	const db = makeDb();
	const id = insertMatched(db);
	const log: LlmRequest[] = [];
	await enrichTransaction(db, cannedLlm(['{"description": "AirPods Pro", "vendor": "Apple"}'], log), id);

	const facts = JSON.parse(rowOf(db, id).f!) as ReceiptFacts;
	expect(facts.description).toBe('AirPods Pro');
	expect(facts.vendor).toBe('Apple');
	expect(log[0].prompt).toContain('AirPods Pro (2nd gen) $249.00'); // the matched body went out
});

test('a malformed reply leaves facts empty and the match intact', async () => {
	const db = makeDb();
	const id = insertMatched(db);
	await enrichTransaction(db, cannedLlm(['no json here']), id);

	const row = rowOf(db, id);
	expect(row.f).toBeNull();
	expect(row.s).toBe('matched');
	expect(row.j).toBeTruthy();
});

test('LLM unavailable → fail-soft: facts empty, match intact', async () => {
	const db = makeDb();
	const id = insertMatched(db);
	await enrichTransaction(db, cannedLlm([new LlmUnavailable('no key')]), id);
	expect(rowOf(db, id).f).toBeNull();
	expect(rowOf(db, id).s).toBe('matched');
});

test('a malformed stored receipt_json skips enrichment quietly — no LLM call, no throw (#14)', async () => {
	const db = makeDb();
	const id = db
		.prepare(
			`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, merchant, amount_cents,
			   receipt_search_state, receipt_json)
			 VALUES (1, 'rx-bad', '2026-07-01', 'APPLE.COM/BILL', 'Apple', -24900, 'matched', '{broken')
			 RETURNING id`
		)
		.pluck()
		.get() as number;
	const log: LlmRequest[] = [];
	await enrichTransaction(db, cannedLlm(['{"description": "x"}'], log), id);
	expect(log).toHaveLength(0);
	expect(rowOf(db, id).f).toBeNull();
});
