import { test, expect } from 'vitest';
import Database, { type Database as Db } from 'better-sqlite3';
import { migrate } from './db/migrate';
import { buildWeeklyDigest, isoWeekStart, shiftDays } from './weekly-digest';

// Week under test: Mon 2026-06-22 .. Sun 2026-06-28 (the completed week
// before TODAY=2026-07-04); previous week Mon 2026-06-15 .. Sun 2026-06-21.
const WEEK = '2026-06-22';

function makeDb() {
	const db = new Database(':memory:');
	migrate(db);
	db.prepare("INSERT INTO connections (institution_name, plaid_item_id) VALUES ('B', 'i')").run();
	db.prepare(
		`INSERT INTO accounts (connection_id, plaid_account_id, name, type, subtype, mask)
		 VALUES (1, 'a1', 'LEAKY-ACCOUNT-NAME', 'depository', 'checking', '4242')`
	).run();
	return db;
}

let seq = 0;
function txn(
	db: Db,
	date: string,
	cents: number,
	over: { merchant?: string; is_transfer?: number; is_investment?: number; recurring?: number | null; category_id?: number | null } = {}
) {
	db.prepare(
		`INSERT INTO transactions
		 (account_id, plaid_transaction_id, date, name, merchant, amount_cents,
		  is_transfer, is_investment_activity, recurring_series_id, category_id)
		 VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		`t-${++seq}`,
		date,
		over.merchant ?? 'SHOP',
		over.merchant ?? 'SHOP',
		cents,
		over.is_transfer ?? 0,
		over.is_investment ?? 0,
		over.recurring ?? null,
		over.category_id ?? null
	);
}

test('ISO week helpers: Monday start, year boundary included', () => {
	expect(isoWeekStart('2026-07-04')).toBe('2026-06-29'); // Saturday → that week's Monday
	expect(isoWeekStart('2026-06-29')).toBe('2026-06-29'); // Monday is its own start
	expect(isoWeekStart('2026-06-28')).toBe('2026-06-22'); // Sunday belongs to the ending week
	expect(isoWeekStart('2026-01-01')).toBe('2025-12-29'); // week spans the year boundary
	expect(shiftDays('2026-01-01', -1)).toBe('2025-12-31');
});

test('week bounds: Monday and Sunday count, neighbors do not', () => {
	const db = makeDb();
	txn(db, '2026-06-21', -1000); // previous Sunday — out
	txn(db, '2026-06-22', -2000); // Monday — in
	txn(db, '2026-06-28', -3000); // Sunday — in
	txn(db, '2026-06-29', -4000); // next Monday — out
	const d = buildWeeklyDigest(db, WEEK);
	expect(d.summary.expenses_dollars).toBe(50);
	expect(d.week_end).toBe('2026-06-28');
});

test('a year-boundary week aggregates across both years', () => {
	const db = makeDb();
	txn(db, '2025-12-30', -5000);
	txn(db, '2026-01-02', -7000);
	const d = buildWeeklyDigest(db, '2025-12-29');
	expect(d.summary.expenses_dollars).toBe(120);
});

test('week-over-week: previous figures and per-category prev spend', () => {
	const db = makeDb();
	txn(db, '2026-06-16', -10000, { merchant: 'CAFE' }); // prev week
	txn(db, '2026-06-23', -25000, { merchant: 'CAFE' }); // this week
	txn(db, '2026-06-24', 50000, { merchant: 'EMPLOYER' }); // income this week
	const d = buildWeeklyDigest(db, WEEK);
	expect(d.previous.expenses_dollars).toBe(100);
	expect(d.summary.expenses_dollars).toBe(250);
	expect(d.summary.income_dollars).toBe(500);
	expect(d.summary.cash_flow_dollars).toBe(250);
	const uncat = d.top_categories.find((c) => c.name === 'Uncategorized')!;
	expect(uncat.spent_dollars).toBe(250);
	expect(uncat.prev_spent_dollars).toBe(100);
});

test('large one-offs: ≥ $100 and non-recurring only, largest first', () => {
	const db = makeDb();
	db.prepare(
		`INSERT INTO recurring_series (merchant, cadence, typical_amount_cents, last_amount_cents, first_seen, last_seen)
		 VALUES ('RENT CO', 'monthly', 150000, 150000, '2026-01-01', '2026-06-22')`
	).run();
	txn(db, '2026-06-22', -150000, { merchant: 'RENT CO', recurring: 1 }); // recurring — out
	txn(db, '2026-06-23', -9999, { merchant: 'LUNCH' }); // under the line — out
	txn(db, '2026-06-24', -30000, { merchant: 'AIRLINE' });
	txn(db, '2026-06-25', -60000, { merchant: 'DENTIST' });
	const d = buildWeeklyDigest(db, WEEK);
	expect(d.large_one_offs.map((o) => o.description)).toEqual(['DENTIST', 'AIRLINE']);
	expect(d.large_one_offs[0].amount_dollars).toBe(600);
});

test('ADR-0003: transfers and investment activity never count', () => {
	const db = makeDb();
	txn(db, '2026-06-23', -20000);
	txn(db, '2026-06-23', -99900, { is_transfer: 1 });
	txn(db, '2026-06-23', 99900, { is_transfer: 1 });
	txn(db, '2026-06-24', -55500, { is_investment: 1 });
	const d = buildWeeklyDigest(db, WEEK);
	expect(d.summary.expenses_dollars).toBe(200);
	expect(d.summary.income_dollars).toBe(0);
	expect(d.summary.txn_count).toBe(1);
	expect(d.large_one_offs).toHaveLength(1); // the transfer/investment rows never surface
	expect(d.top_merchants).toHaveLength(1);
});

test('data-quality counts ride the digest so narration can hedge', () => {
	const db = makeDb();
	txn(db, '2026-06-23', -20000);
	db.prepare("UPDATE transactions SET unresolved = 1").run();
	db.prepare("INSERT INTO review_items (kind, payload) VALUES ('transfer-ambiguity', '{}')").run();
	db.prepare(
		"INSERT INTO review_items (kind, payload, status, resolved_at) VALUES ('proposal', '{}', 'rejected', datetime('now'))"
	).run();
	const d = buildWeeklyDigest(db, WEEK);
	expect(d.data_quality).toEqual({
		open_review_items: 1,
		unresolved_charges: 1,
		rejected_not_reopened: 1
	});
});

test('the digest physically has no account fields', () => {
	const db = makeDb();
	txn(db, '2026-06-23', -20000);
	const json = JSON.stringify(buildWeeklyDigest(db, WEEK));
	expect(json).not.toContain('LEAKY-ACCOUNT-NAME');
	expect(json).not.toContain('4242');
});
