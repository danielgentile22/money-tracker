import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import { runCategorizationScan, runReceiptScan, runLookupBatch, backfillProgress } from './backfill';
import type { ChargeFacts, ReceiptCandidate } from './gmail';
import type { LlmRequest } from './llm';

function makeDb() {
	const db = new Database(':memory:');
	migrate(db);
	db.prepare("INSERT INTO connections (institution_name, plaid_item_id) VALUES ('B', 'i')").run();
	db.prepare(
		"INSERT INTO accounts (connection_id, plaid_account_id, name, type, subtype) VALUES (1, 'a1', 'Checking', 'depository', 'checking')"
	).run();
	// receipt scans now refuse over a dead Gmail connection (#05) — give them a live inbox
	db.prepare("INSERT INTO inboxes (address, status) VALUES ('owner@gmail.com', 'connected')").run();
	return db;
}

test('the two full scans re-categorize model-rung history, re-extract matched Receipts, and queue nothing for review', async () => {
	const db = makeDb();
	// an old model-categorized charge (a better model should be able to improve it)
	const id = db
		.prepare(
			`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, merchant, amount_cents, unresolved, category_id, category_source)
			 VALUES (1, 'old-1', '2025-08-01', 'RAW', 'AMZN Mktp US', -6347, 1,
			   (SELECT id FROM categories WHERE name = 'Other'), 'llm') RETURNING id`
		)
		.pluck()
		.get() as number;

	const searched: ChargeFacts[] = [];
	const source = {
		async searchReceipts(charge: ChargeFacts): Promise<ReceiptCandidate[]> {
			searched.push(charge);
			return [
				{
					inboxAddress: 'owner@gmail.com',
					messageId: 'm1',
					from: 'orders@amzn.example.com',
					subject: 'Your order: $63.47',
					date: '2025-08-01',
					snippet: ''
				}
			];
		},
		async fetchBody() {
			return 'Order details: 1x USB-C cable $63.47';
		}
	};
	const prompts: string[] = [];
	const llm = async (req: LlmRequest) => {
		prompts.push(req.prompt);
		return req.prompt.startsWith('Categorize')
			? '{"1": "Shopping"}'
			: '{"description": "1x USB-C cable", "vendor": "Amazon"}';
	};

	await runCategorizationScan(db, llm);
	await runReceiptScan(db, source, llm);

	expect(searched.length).toBe(1); // the age gate was ignored
	const state = () =>
		db
			.prepare(
				'SELECT category_source AS src, receipt_search_state AS state, receipt_facts_json AS facts FROM transactions WHERE id = ?'
			)
			.get(id) as { src: string; state: string; facts: string | null };
	let row = state();
	expect(row.state).toBe('matched');
	expect(JSON.parse(row.facts!).description).toBe('1x USB-C cable');
	// the receipt scan only gathers evidence — the Category is NOT re-judged
	expect(row.src).toBe('llm');

	// the next categorization pass consumes the facts and names its evidence
	await runCategorizationScan(db, llm);
	row = state();
	expect(row.src).toBe('llm+receipt');
	// the extractor judged from the full body, and no Proposal was queued
	expect(prompts.find((p) => !p.startsWith('Categorize'))).toContain('USB-C cable');
	expect(db.prepare('SELECT COUNT(*) FROM review_items').pluck().get()).toBe(0);
});

test('full receipt scan redoes everything; month scan skips old and matched charges', async () => {
	const db = makeDb();
	const insert = db.prepare(
		`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, merchant, amount_cents, unresolved, category_source, receipt_search_state)
		 VALUES (1, ?, ?, 'RAW', 'Some Shop', -1200, 1, 'plaid', ?)`
	);
	insert.run('old-2', '2025-08-01', 'exhausted'); // ancient, already given up
	const recent = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
	insert.run('new-1', recent, null); // this month, never searched
	insert.run('new-2', recent, 'matched'); // this month, already has a receipt
	const searched: ChargeFacts[] = [];
	const drySource = {
		async searchReceipts(charge: ChargeFacts): Promise<ReceiptCandidate[]> {
			searched.push(charge);
			return [];
		}
	};
	const llm = async () => JSON.stringify({});

	await runReceiptScan(db, drySource, llm, 'month');
	expect(searched.length).toBe(1); // only the recent unmatched charge

	await runReceiptScan(db, drySource, llm, 'all');
	expect(searched.length).toBe(1 + 3); // full redo: all three, matched included
});

test('a receipt scan refuses over a dead Gmail connection instead of searching (#05)', async () => {
	const db = makeDb();
	db.prepare("UPDATE inboxes SET status = 'expired'").run(); // the only inbox died
	db.prepare(
		`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, merchant, amount_cents, unresolved, receipt_search_state, receipt_json)
		 VALUES (1, 'm-1', '2026-07-01', 'RAW', 'Shop', -1200, 1, 'matched', '{"messageId":"keep"}')`
	).run();
	const searched: ChargeFacts[] = [];
	const source = {
		async searchReceipts(c: ChargeFacts): Promise<ReceiptCandidate[]> {
			searched.push(c);
			return [];
		}
	};
	await runReceiptScan(db, source, async () => '{}');
	await runLookupBatch(db, source, async () => '{}', [1]);
	expect(searched).toHaveLength(0); // never queried Gmail
	expect(backfillProgress(db)?.label).toContain('no connected inbox');
	// the prior match is intact — nothing was wiped
	const state = db
		.prepare('SELECT receipt_search_state AS s, receipt_json AS j FROM transactions WHERE id = 1')
		.get() as { s: string; j: string };
	expect(state.s).toBe('matched');
	expect(state.j).toContain('keep');
});

test('lookup batch searches exactly the given charges and enriches fresh matches', async () => {
	const db = makeDb();
	const insert = db.prepare(
		`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, merchant, amount_cents, unresolved, category_id, category_source)
		 VALUES (1, ?, '2025-08-01', 'RAW', ?, ?, 1, (SELECT id FROM categories WHERE name = 'Other'), 'plaid') RETURNING id`
	);
	const hit = insert.pluck().get('b-1', 'AMZN Mktp US', -6347) as number;
	const miss = insert.pluck().get('b-2', 'Some Shop', -1200) as number;
	insert.pluck().get('b-3', 'Untouched', -500); // not in the batch — must stay unsearched

	const searched: ChargeFacts[] = [];
	const source = {
		async searchReceipts(charge: ChargeFacts): Promise<ReceiptCandidate[]> {
			searched.push(charge);
			return charge.amount_cents === -6347
				? [
						{
							inboxAddress: 'owner@gmail.com',
							messageId: 'm1',
							from: 'orders@amzn.example.com',
							subject: 'Your order: $63.47',
							date: '2025-08-01',
							snippet: ''
						}
					]
				: [];
		},
		async fetchBody() {
			return 'Order details: 1x USB-C cable $63.47';
		}
	};
	const llm = async (req: LlmRequest) =>
		req.prompt.startsWith('Categorize')
			? '{"1": "Shopping"}'
			: '{"description": "1x USB-C cable", "vendor": "Amazon"}';

	await runLookupBatch(db, source, llm, [hit, miss]);

	expect(searched.length).toBe(2); // the age gate is ignored, the third charge untouched
	const row = db
		.prepare(
			'SELECT category_source AS src, receipt_facts_json AS facts FROM transactions WHERE id = ?'
		)
		.get(hit) as { src: string; facts: string | null };
	expect(JSON.parse(row.facts!).description).toBe('1x USB-C cable');
	expect(row.src).toBe('llm+receipt');
});
