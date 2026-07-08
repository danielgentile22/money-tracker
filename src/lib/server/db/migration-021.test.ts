import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './migrate';

// Migration 021 (enrich-then-categorize): the proposer disappears. Existing
// rows carry over — proposal-failed matches stand, open Proposals close.

function seededDb() {
	const db = new Database(':memory:');
	migrate(db, 20); // the pre-enrichment world
	db.prepare("INSERT INTO connections (institution_name, plaid_item_id) VALUES ('B', 'i')").run();
	db.prepare(
		"INSERT INTO accounts (connection_id, plaid_account_id, name, type) VALUES (1, 'a', 'Checking', 'depository')"
	).run();
	return db;
}

test('proposal-failed rows become matched — the match itself still stands', () => {
	const db = seededDb();
	db.prepare(
		`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, amount_cents,
		   receipt_search_state, receipt_json)
		 VALUES (1, 'rx-1', '2026-06-01', 'RAW', -100, 'proposal-failed', '{"messageId":"m1"}')`
	).run();

	migrate(db);

	const row = db
		.prepare('SELECT receipt_search_state AS s, receipt_json AS j FROM transactions')
		.get() as { s: string; j: string };
	expect(row.s).toBe('matched');
	expect(row.j).toBeTruthy();
});

test('open Proposals close; Transfer review items and owner-judged Proposals are untouched', () => {
	const db = seededDb();
	db.prepare("INSERT INTO review_items (kind, payload) VALUES ('proposal', '{}')").run();
	db.prepare(
		"INSERT INTO review_items (kind, payload, status) VALUES ('proposal', '{}', 'approved')"
	).run();
	db.prepare("INSERT INTO review_items (kind, payload) VALUES ('transfer', '{}')").run();

	migrate(db);

	const statuses = db
		.prepare('SELECT kind, status FROM review_items ORDER BY id')
		.all() as { kind: string; status: string }[];
	expect(statuses[0].status).not.toBe('open'); // open Proposal closed
	expect(statuses[1].status).toBe('approved'); // owner judgment kept
	expect(statuses[2]).toEqual({ kind: 'transfer', status: 'open' }); // pairing untouched
});

test('legacy category sources survive the CHECK rebuild; the new rung is writable', () => {
	const db = seededDb();
	const other = db.prepare("SELECT id FROM categories WHERE name = 'Other'").pluck().get();
	db.prepare(
		`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, amount_cents,
		   category_id, category_source)
		 VALUES (1, 'rx-1', '2026-06-01', 'RAW', -100, ?, 'proposal')`
	).run(other);

	migrate(db);

	expect(
		db.prepare('SELECT category_source FROM transactions').pluck().get()
	).toBe('proposal');
	db.prepare("UPDATE transactions SET category_source = 'llm+receipt'").run(); // must not throw
});
