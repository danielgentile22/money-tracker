import type { Database } from 'better-sqlite3';

// The single source of truth for Phase 2 aggregates. ADR-0003's exclusions are
// enforced HERE and nowhere else: is_transfer out of income/expenses/cash flow,
// is_saved feeds savings rate, is_investment_activity invisible. Amounts are
// INTEGER cents, owner-signed (negative = out). Calendar months, local time.

export type MonthSummary = {
	month: string; // 'YYYY-MM'
	income_cents: number;
	expenses_cents: number; // positive magnitude
	cash_flow_cents: number; // income − expenses
	saved_cents: number; // positive magnitude of is_saved legs
	savings_rate: number | null; // saved / income; null when the month has no income
	txn_count: number; // non-excluded rows backing income/expenses
};

// A row belongs to a real expense Category (has one, and it's not the Income
// group). Positive such rows are refunds that net against spend (#24); rows
// without a Category or in the Income group keep the plain sign discipline.
// Requires the caller to alias transactions as `t` and LEFT JOIN categories c
// / category_groups g.
const IS_EXPENSE_CAT = "(c.id IS NOT NULL AND g.name != 'Income')";

/** [start, end) date bounds of a calendar month, year wrap included. */
function monthBounds(month: string): { start: string; end: string } {
	const [y, m] = month.split('-').map(Number);
	const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
	return { start: `${month}-01`, end: `${next}-01` };
}

export function monthSummary(db: Database, month: string): MonthSummary {
	const { start, end } = monthBounds(month);
	// A positive row in a real expense Category is a refund, not income: it nets
	// against that Category's spend and never counts toward income, so cash flow
	// reconciles with the sum of Category actuals (#24). Uncategorized and
	// Income-group positives stay income — refunds are only netted where they
	// unambiguously reverse a categorized charge.
	const row = db
		.prepare(
			`SELECT
			   COALESCE(SUM(CASE WHEN t.is_transfer = 0 AND t.amount_cents > 0 AND NOT ${IS_EXPENSE_CAT}
			                     THEN t.amount_cents END), 0) AS income,
			   COALESCE(SUM(CASE WHEN t.is_transfer = 0 AND (t.amount_cents < 0 OR ${IS_EXPENSE_CAT})
			                     THEN -t.amount_cents END), 0) AS expenses,
			   COALESCE(SUM(CASE WHEN t.is_saved = 1 THEN ABS(t.amount_cents) END), 0) AS saved,
			   COALESCE(SUM(t.is_transfer = 0), 0) AS txn_count
			 FROM transactions t
			 LEFT JOIN categories c ON c.id = t.category_id
			 LEFT JOIN category_groups g ON g.id = c.group_id
			 WHERE t.is_investment_activity = 0 AND t.date >= ? AND t.date < ?`
		)
		.get(start, end) as { income: number; expenses: number; saved: number; txn_count: number };
	return {
		month,
		income_cents: row.income,
		expenses_cents: row.expenses,
		cash_flow_cents: row.income - row.expenses,
		saved_cents: row.saved,
		savings_rate: row.income > 0 ? row.saved / row.income : null,
		txn_count: row.txn_count
	};
}

export type CategorySpend = { category_id: number | null; name: string | null; spent_cents: number };

/** Spend magnitude per Category for one month; Transfers/income/investment rows never appear. */
export function spendingByCategory(db: Database, month: string): CategorySpend[] {
	const { start, end } = monthBounds(month);
	// Refunds in an expense Category net against its spend; income/uncategorized
	// positives are excluded, same as before (#24).
	return db
		.prepare(
			`SELECT t.category_id, c.name, SUM(-t.amount_cents) AS spent_cents
			 FROM transactions t
			 LEFT JOIN categories c ON c.id = t.category_id
			 LEFT JOIN category_groups g ON g.id = c.group_id
			 WHERE t.is_investment_activity = 0 AND t.is_transfer = 0
			   AND (t.amount_cents < 0 OR ${IS_EXPENSE_CAT})
			   AND t.date >= ? AND t.date < ?
			 GROUP BY t.category_id ORDER BY spent_cents DESC`
		)
		.all(start, end) as CategorySpend[];
}

export type CategoryIncome = { category_id: number | null; income_cents: number };

/** Income magnitude per Category for one month; Transfers/investment rows never appear. */
export function incomeByCategory(db: Database, month: string): CategoryIncome[] {
	const { start, end } = monthBounds(month);
	return db
		.prepare(
			`SELECT category_id, SUM(amount_cents) AS income_cents
			 FROM transactions
			 WHERE is_investment_activity = 0 AND is_transfer = 0 AND amount_cents > 0
			   AND date >= ? AND date < ?
			 GROUP BY category_id`
		)
		.all(start, end) as CategoryIncome[];
}

/** 'YYYY-MM' shifted by delta months (delta may be negative). */
export function shiftMonth(month: string, delta: number): string {
	const [y, m] = month.split('-').map(Number);
	const n = y * 12 + (m - 1) + delta;
	return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`;
}

/** Successive 'YYYY-MM' strings, inclusive. */
export function monthRange(from: string, to: string): string[] {
	const months: string[] = [];
	let [y, m] = from.split('-').map(Number);
	while (true) {
		const cur = `${y}-${String(m).padStart(2, '0')}`;
		months.push(cur);
		if (cur >= to) break;
		if (++m > 12) (m = 1), y++;
	}
	return months;
}

export type TrendPoint = { month: string; spent_cents: number };

/** Monthly spend for one Category over [from, to] months, zero-filled so gaps are visible. */
export function categoryTrend(db: Database, categoryId: number, from: string, to: string): TrendPoint[] {
	// Refunds net against the Category's spend (#24); for an Income-group
	// Category the predicate reduces to negatives-only, as before.
	const rows = db
		.prepare(
			`SELECT substr(t.date, 1, 7) AS month, SUM(-t.amount_cents) AS spent_cents
			 FROM transactions t
			 LEFT JOIN categories c ON c.id = t.category_id
			 LEFT JOIN category_groups g ON g.id = c.group_id
			 WHERE t.is_investment_activity = 0 AND t.is_transfer = 0
			   AND (t.amount_cents < 0 OR ${IS_EXPENSE_CAT})
			   AND t.category_id = ? AND t.date >= ? AND t.date < ?
			 GROUP BY month`
		)
		.all(categoryId, `${from}-01`, monthBounds(to).end) as TrendPoint[];
	const byMonth = new Map(rows.map((r) => [r.month, r.spent_cents]));
	return monthRange(from, to).map((month) => ({ month, spent_cents: byMonth.get(month) ?? 0 }));
}

/** Analytics needing trailing history declare a minimum in full months (PRD default). */
export const MIN_FULL_MONTHS = 3;

/**
 * Complete calendar months of ledger history strictly before today's month.
 * The explicit insufficient-history signal: consumers compare against their
 * minimum instead of rendering silent zeros.
 */
export function fullMonthsOfHistory(db: Database, today: string): number {
	const first = db
		.prepare('SELECT MIN(date) FROM transactions WHERE is_investment_activity = 0')
		.pluck()
		.get() as string | null;
	if (!first) return 0;
	// count whole months in [month after first data, current month)
	const [fy, fm] = [Number(first.slice(0, 4)), Number(first.slice(5, 7))];
	const [ty, tm] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
	return Math.max(0, (ty - fy) * 12 + (tm - fm) - 1);
}
