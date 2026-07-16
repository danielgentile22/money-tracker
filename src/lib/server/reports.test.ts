import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import { reportData, netWorthReport, donutSlices } from './reports';
import type { FilterSet } from './filters';

const TODAY = '2026-07-04';
const ALL: FilterSet = { date: { preset: 'all' } };

function makeDb() {
	const db = new Database(':memory:');
	migrate(db);
	db.prepare("INSERT INTO connections (institution_name, plaid_item_id) VALUES ('B', 'i')").run();
	const acct = db.prepare(
		'INSERT INTO accounts (connection_id, plaid_account_id, name, type, subtype) VALUES (1, ?, ?, ?, ?)'
	);
	acct.run('a-checking', 'Checking', 'depository', 'checking');
	acct.run('a-savings', 'Savings', 'depository', 'savings');
	return db;
}

type Fixture = {
	date?: string;
	amount_cents?: number;
	account_id?: number;
	merchant?: string | null;
	name?: string;
	category?: string;
	is_transfer?: number;
	is_investment_activity?: number;
	tags?: string[];
};

let seq = 0;
function insert(db: Database.Database, rows: Fixture[]) {
	const stmt = db.prepare(
		`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, merchant, amount_cents,
		   category_id, is_transfer, is_investment_activity)
		 VALUES (?, ?, ?, ?, ?, ?, (SELECT id FROM categories WHERE name = ?), ?, ?) RETURNING id`
	);
	for (const r of rows) {
		const id = stmt
			.pluck()
			.get(
				r.account_id ?? 1,
				`fx-${++seq}`,
				r.date ?? '2026-06-15',
				r.name ?? 'FIXTURE',
				r.merchant === undefined ? 'FIXTURE' : r.merchant,
				r.amount_cents ?? -1000,
				r.category ?? null,
				r.is_transfer ?? 0,
				r.is_investment_activity ?? 0
			) as number;
		for (const tag of r.tags ?? []) {
			const tagId = db
				.prepare('INSERT INTO tags (name) VALUES (?) ON CONFLICT (name) DO UPDATE SET name = name RETURNING id')
				.pluck()
				.get(tag) as number;
			db.prepare('INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)').run(id, tagId);
		}
	}
}

test('monthly series is zero-filled over the resolved range, totals hand-checked', () => {
	const db = makeDb();
	insert(db, [
		{ date: '2026-05-10', amount_cents: -2_500, category: 'Coffee' },
		{ date: '2026-05-20', amount_cents: -7_500, category: 'Dining' },
		{ date: '2026-07-01', amount_cents: -4_000, category: 'Dining' }
		// June: nothing — the gap must render as an explicit zero
	]);
	const r = reportData(db, { date: { preset: 'last-3-months' } }, 'spending', 'category', {
		today: TODAY
	});
	expect(r.months).toEqual([
		{ month: '2026-05', total_cents: 10_000 },
		{ month: '2026-06', total_cents: 0 },
		{ month: '2026-07', total_cents: 4_000 }
	]);
	// avg is over the two COMPLETE months (May+June = $100), not the partial July:
	// $10,000 / 2 = $5,000, never $14,000 / 3 (#65). total still spans the range.
	expect(r.stats).toEqual({ total_cents: 14_000, monthly_avg_cents: 5_000, txn_count: 3 });
});

// #65: early in the month the partial current-month spend must not drag the
// average down — a range with one complete month averages over that month only.
test('monthly average excludes the in-progress month', () => {
	const db = makeDb();
	insert(db, [
		{ date: '2026-06-15', amount_cents: -30_000, category: 'Dining' }, // one full month
		{ date: '2026-07-02', amount_cents: -1_000, category: 'Dining' } // barely into July
	]);
	const r = reportData(db, { date: { preset: 'last-3-months' } }, 'spending', 'category', {
		today: TODAY // 2026-07-04 → May, June (complete) + partial July
	});
	// $30k over the two complete months (May 0 + June 30k), July's partial $1k
	// excluded: $15,000 — not the biased $31k / 3 = $10,333.
	expect(r.stats.monthly_avg_cents).toBe(15_000);
});

test('income vs spending sign discipline; Transfers and investment rows never count', () => {
	const db = makeDb();
	insert(db, [
		{ date: '2026-06-01', amount_cents: 500_000, category: 'Income' },
		{ date: '2026-06-05', amount_cents: -12_000, category: 'Dining' },
		{ date: '2026-06-10', amount_cents: -84_200, is_transfer: 1 },
		{ date: '2026-06-10', amount_cents: 84_200, account_id: 2, is_transfer: 1 },
		{ date: '2026-06-11', amount_cents: -5_000, is_investment_activity: 1 }
	]);
	const spend = reportData(db, ALL, 'spending', 'category', { today: TODAY });
	expect(spend.stats.total_cents).toBe(12_000);
	expect(spend.stats.txn_count).toBe(1);
	const income = reportData(db, ALL, 'income', 'category', { today: TODAY });
	expect(income.stats.total_cents).toBe(500_000);
	expect(income.breakdown).toEqual([
		{ id: expect.any(Number), label: 'Income', amount_cents: 500_000, share: 1 }
	]);
});

test('breakdown groups by all four dimensions', () => {
	const db = makeDb();
	insert(db, [
		{ amount_cents: -3_000, category: 'Coffee', merchant: 'Starbucks', tags: ['work'] },
		{ amount_cents: -1_000, category: 'Coffee', merchant: 'Starbucks' },
		{ amount_cents: -6_000, category: 'Dining', merchant: 'Chipotle' },
		{ amount_cents: -11_000, category: 'Travel', merchant: null, name: 'DELTA' }
	]);
	const by = (g: 'group' | 'category' | 'merchant' | 'tag') =>
		reportData(db, ALL, 'spending', g, { today: TODAY }).breakdown.map((b) => [
			b.label,
			b.amount_cents
		]);
	expect(by('group')).toEqual([
		['Travel & Lifestyle', 11_000],
		['Food & Dining', 10_000]
	]);
	expect(by('category')).toEqual([
		['Travel', 11_000],
		['Dining', 6_000],
		['Coffee', 4_000]
	]);
	expect(by('merchant')).toEqual([
		['DELTA', 11_000],
		['Chipotle', 6_000],
		['Starbucks', 4_000]
	]);
	expect(by('tag')).toEqual([
		['Untagged', 18_000],
		['work', 3_000]
	]);
});

test('shares are fractions of the filtered total', () => {
	const db = makeDb();
	insert(db, [
		{ amount_cents: -7_500, category: 'Dining' },
		{ amount_cents: -2_500, category: 'Coffee' }
	]);
	const r = reportData(db, ALL, 'spending', 'category', { today: TODAY });
	expect(r.breakdown.map((b) => b.share)).toEqual([0.75, 0.25]);
});

test('drill-down rows match the aggregates they back', () => {
	const db = makeDb();
	insert(db, [
		{ amount_cents: -12_000, category: 'Dining' },
		{ amount_cents: 500_000, category: 'Income' }, // income: not in spending drill-down
		{ amount_cents: -84_200, is_transfer: 1 } // transfer: never listed
	]);
	const r = reportData(db, ALL, 'spending', 'category', { today: TODAY });
	expect(r.rows.map((row) => row.amount_cents)).toEqual([-12_000]);
	expect(r.rows.reduce((s, row) => s - row.amount_cents, 0)).toBe(r.stats.total_cents);
});

test('filters narrow the report: exclude a Tag, keep the rest', () => {
	const db = makeDb();
	insert(db, [
		{ amount_cents: -30_000, category: 'Dining', tags: ['vacation'] },
		{ amount_cents: -5_000, category: 'Dining' }
	]);
	const vacationId = db.prepare("SELECT id FROM tags WHERE name = 'vacation'").pluck().get() as number;
	const r = reportData(
		db,
		{ tags: { exclude: [vacationId] }, date: { preset: 'all' } },
		'spending',
		'category',
		{ today: TODAY }
	);
	expect(r.stats.total_cents).toBe(5_000);
	expect(r.rows).toHaveLength(1);
});

test('donutSlices rolls the tail into "other" with summed share', () => {
	const rows = Array.from({ length: 10 }, (_, i) => ({
		id: i + 1,
		label: `c${i + 1}`,
		amount_cents: 1_000 - i * 10,
		share: 0.1
	}));
	const slices = donutSlices(rows, 8);
	expect(slices).toHaveLength(9);
	expect(slices[8]).toEqual({
		id: null,
		label: 'Other',
		amount_cents: rows[8].amount_cents + rows[9].amount_cents,
		share: rows[8].share + rows[9].share
	});
	expect(donutSlices(rows.slice(0, 3), 8)).toHaveLength(3);
});

// --- net worth tab ---

function snap(db: Database.Database, accountId: number, date: string, cents: number) {
	db.prepare(
		'INSERT INTO snapshots (account_id, date, balance_cents, estimated) VALUES (?, ?, ?, 0)'
	).run(accountId, date, cents);
}

test('net-worth tab windows the snapshot series to the date range', () => {
	const db = makeDb();
	snap(db, 1, '2026-04-30', 100_000);
	snap(db, 1, '2026-06-10', 120_000);
	snap(db, 1, '2026-07-01', 130_000);
	const r = netWorthReport(db, { date: { from: '2026-06-01', to: '2026-06-30' } }, TODAY);
	expect(r).toEqual([{ date: '2026-06-10', balance_cents: 120_000, estimated: 0 }]);
});

test('net-worth tab respects Account filters and ignores inapplicable dimensions', () => {
	const db = makeDb();
	snap(db, 1, '2026-06-10', 100_000);
	snap(db, 2, '2026-06-10', 50_000);
	// a category filter is meaningless for balances — ignored, both accounts sum
	const all = netWorthReport(db, { categories: { include: [999] }, date: { preset: 'all' } }, TODAY);
	expect(all).toEqual([{ date: '2026-06-10', balance_cents: 150_000, estimated: 0 }]);
	const only1 = netWorthReport(db, { accounts: { include: [1] }, date: { preset: 'all' } }, TODAY);
	expect(only1).toEqual([{ date: '2026-06-10', balance_cents: 100_000, estimated: 0 }]);
	const not1 = netWorthReport(db, { accounts: { exclude: [1] }, date: { preset: 'all' } }, TODAY);
	expect(not1).toEqual([{ date: '2026-06-10', balance_cents: 50_000, estimated: 0 }]);
});
