import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import { monthSummary, spendingByCategory, categoryTrend, fullMonthsOfHistory } from './analytics';

function makeDb() {
	const db = new Database(':memory:');
	migrate(db);
	db.prepare("INSERT INTO connections (institution_name, plaid_item_id) VALUES ('B', 'i')").run();
	const acct = db.prepare(
		'INSERT INTO accounts (connection_id, plaid_account_id, name, type, subtype) VALUES (1, ?, ?, ?, ?)'
	);
	acct.run('a-checking', 'Checking', 'depository', 'checking');
	acct.run('a-savings', 'Savings', 'depository', 'savings');
	acct.run('a-card', 'Credit Card', 'credit', 'credit card');
	return db;
}

type Fixture = {
	date: string;
	amount_cents: number;
	account_id?: number;
	merchant?: string;
	category?: string; // category name, resolved via lookup
	is_transfer?: number;
	is_saved?: number;
	is_investment_activity?: number;
};

let seq = 0;
function insert(db: Database.Database, rows: Fixture[]) {
	const stmt = db.prepare(
		`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, merchant, amount_cents,
		   category_id, is_transfer, is_saved, is_investment_activity)
		 VALUES (?, ?, ?, ?, ?, ?, (SELECT id FROM categories WHERE name = ?), ?, ?, ?)`
	);
	for (const r of rows) {
		stmt.run(
			r.account_id ?? 1,
			`fx-${++seq}`,
			r.date,
			r.merchant ?? 'FIXTURE',
			r.merchant ?? null,
			r.amount_cents,
			r.category ?? null,
			r.is_transfer ?? 0,
			r.is_saved ?? 0,
			r.is_investment_activity ?? 0
		);
	}
}

// --- exclusions (ADR-0003, enforced here and nowhere else) ---

test('credit-card payment (Transfer pair) never moves income, expenses, or cash flow', () => {
	const db = makeDb();
	insert(db, [
		{ date: '2026-06-01', amount_cents: 500_000 }, // paycheck
		{ date: '2026-06-05', amount_cents: -12_000, category: 'Dining' },
		// the payment pair: checking out-leg + card in-leg, both flagged
		{ date: '2026-06-10', amount_cents: -84_200, is_transfer: 1 },
		{ date: '2026-06-10', amount_cents: 84_200, account_id: 3, is_transfer: 1 }
	]);
	expect(monthSummary(db, '2026-06')).toEqual({
		month: '2026-06',
		income_cents: 500_000,
		expenses_cents: 12_000,
		cash_flow_cents: 488_000,
		saved_cents: 0,
		savings_rate: 0,
		txn_count: 2
	});
});

test('a savings contribution counts as saved (savings rate), never as spending', () => {
	const db = makeDb();
	insert(db, [
		{ date: '2026-06-01', amount_cents: 400_000 },
		// paired move: checking out-leg + savings in-leg (in-leg marked saved, p1-06)
		{ date: '2026-06-03', amount_cents: -100_000, is_transfer: 1 },
		{ date: '2026-06-03', amount_cents: 100_000, account_id: 2, is_transfer: 1, is_saved: 1 }
	]);
	const s = monthSummary(db, '2026-06');
	expect(s.expenses_cents).toBe(0);
	expect(s.saved_cents).toBe(100_000);
	expect(s.savings_rate).toBe(0.25);
	// one-sided 529 leg (p1-12): out-leg itself flagged saved, still not spending
	insert(db, [{ date: '2026-06-15', amount_cents: -50_000, is_transfer: 1, is_saved: 1 }]);
	const s2 = monthSummary(db, '2026-06');
	expect(s2.expenses_cents).toBe(0);
	expect(s2.saved_cents).toBe(150_000);
});

test('internal investment activity is invisible', () => {
	const db = makeDb();
	insert(db, [
		{ date: '2026-06-02', amount_cents: -30_000, category: 'Dining' },
		{ date: '2026-06-02', amount_cents: 99_999, is_investment_activity: 1 }, // dividend
		{ date: '2026-06-03', amount_cents: -88_888, is_investment_activity: 1 } // internal buy
	]);
	const s = monthSummary(db, '2026-06');
	expect(s.income_cents).toBe(0);
	expect(s.expenses_cents).toBe(30_000);
	expect(s.txn_count).toBe(1);
});

test('calendar-month boundaries hold, including the year wrap', () => {
	const db = makeDb();
	insert(db, [
		{ date: '2025-12-31', amount_cents: -10_000, category: 'Dining' },
		{ date: '2026-01-01', amount_cents: -20_000, category: 'Dining' },
		{ date: '2026-01-31', amount_cents: -40_000, category: 'Dining' },
		{ date: '2026-02-01', amount_cents: -80_000, category: 'Dining' }
	]);
	expect(monthSummary(db, '2025-12').expenses_cents).toBe(10_000);
	expect(monthSummary(db, '2026-01').expenses_cents).toBe(60_000);
	expect(monthSummary(db, '2026-02').expenses_cents).toBe(80_000);
});

// --- category breakdown & trends ---

test('spending by Category: spend only, Transfers and income never included', () => {
	const db = makeDb();
	insert(db, [
		{ date: '2026-06-02', amount_cents: -30_000, category: 'Dining' },
		{ date: '2026-06-09', amount_cents: -20_000, category: 'Dining' },
		{ date: '2026-06-05', amount_cents: -15_000, category: 'Groceries' },
		{ date: '2026-06-06', amount_cents: 12_345, category: 'Income' }, // refund/income: not spending
		{ date: '2026-06-10', amount_cents: -84_200, is_transfer: 1, category: 'Transfer' },
		{ date: '2026-06-11', amount_cents: -5_000 } // uncategorized spend still shows
	]);
	expect(spendingByCategory(db, '2026-06')).toEqual([
		{ category_id: expect.any(Number), name: 'Dining', spent_cents: 50_000 },
		{ category_id: expect.any(Number), name: 'Groceries', spent_cents: 15_000 },
		{ category_id: null, name: null, spent_cents: 5_000 }
	]);
});

test('Category trend: one point per month over the window, zero-filled gaps', () => {
	const db = makeDb();
	insert(db, [
		{ date: '2026-03-10', amount_cents: -10_000, category: 'Groceries' },
		{ date: '2026-05-10', amount_cents: -30_000, category: 'Groceries' },
		{ date: '2026-05-12', amount_cents: -10_000, category: 'Dining' } // other category, excluded
	]);
	const catId = db.prepare("SELECT id FROM categories WHERE name = 'Groceries'").pluck().get() as number;
	expect(categoryTrend(db, catId, '2026-03', '2026-05')).toEqual([
		{ month: '2026-03', spent_cents: 10_000 },
		{ month: '2026-04', spent_cents: 0 },
		{ month: '2026-05', spent_cents: 30_000 }
	]);
});

// --- insufficient history is an explicit signal, never silent zeros ---

test('fullMonthsOfHistory counts complete calendar months, year wrap included', () => {
	const db = makeDb();
	expect(fullMonthsOfHistory(db, '2026-06-15')).toBe(0); // no data at all
	insert(db, [{ date: '2026-06-02', amount_cents: -1_000 }]);
	expect(fullMonthsOfHistory(db, '2026-06-15')).toBe(0); // current month only: not complete
	const db2 = makeDb();
	insert(db2, [{ date: '2025-11-20', amount_cents: -1_000 }]);
	// first data lands mid-Nov-2025 → Dec, Jan, Feb, Mar, Apr, May complete before 2026-06-15
	expect(fullMonthsOfHistory(db2, '2026-06-15')).toBe(6);
});
