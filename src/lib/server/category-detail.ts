import type { Database } from 'better-sqlite3';
import { isProtectedCategory } from './categories';
import { budgetMonth } from './budgets';
import { monthRange, shiftMonth } from './analytics';
import { buildRecurringView, type SeriesRow, type SeriesView } from './recurring-view';

// Category detail engine (ADR-0008, slice 4): everything the open-Category
// panel shows for one (Category, cursor month) — header facts, effective
// Budget/Rollover, per-month trend, and associated Recurring series.

export type CategoryDetail = {
	category_id: number;
	name: string;
	emoji: string | null;
	group_name: string;
	protected: boolean;
	budget_cents: number; // effective (fill-forward); 0 = unbudgeted
	rollover_cents: number | null; // balance entering the month; null when rollover is off
	available_cents: number | null; // budget + rollover − actual; null when rollover is off
	actual_cents: number;
	trend: TrendPoint[]; // 12 months ending at the cursor month, zero-filled
	series: SeriesView[]; // active first (by next expected), then ended
};

export type TrendPoint = { month: string; spent_cents: number };

const TREND_MONTHS = 12;

// ponytail: spending magnitude only — an Income Category's trend reads zero;
// its Ledger still shows the paychecks. Extend to income if the owner asks.
function spendingTrend(db: Database, categoryId: number, month: string): TrendPoint[] {
	const from = shiftMonth(month, -(TREND_MONTHS - 1));
	const rows = db
		.prepare(
			`SELECT substr(date, 1, 7) AS month, SUM(-amount_cents) AS spent
			 FROM transactions
			 WHERE is_investment_activity = 0 AND is_transfer = 0 AND amount_cents < 0
			   AND category_id = ? AND date >= ? AND date < ?
			 GROUP BY month`
		)
		.all(categoryId, `${from}-01`, `${shiftMonth(month, 1)}-01`) as { month: string; spent: number }[];
	const spent = new Map(rows.map((r) => [r.month, r.spent]));
	return monthRange(from, month).map((m) => ({ month: m, spent_cents: spent.get(m) ?? 0 }));
}

// Series have no category axis (keyed on Merchant) — "this Category's series"
// means the Merchant's charges land dominantly here: modal category_id over the
// merchant's transactions, ties broken by lowest id. Good enough for display;
// a charge-level association would need a schema change.
function associatedSeries(db: Database, categoryId: number, today: string): SeriesView[] {
	const rows = db
		.prepare(
			`SELECT id, merchant, cadence, typical_amount_cents, last_amount_cents, first_seen, last_seen
			 FROM recurring_series rs
			 WHERE ? = (SELECT t.category_id FROM transactions t
			            WHERE t.merchant = rs.merchant AND t.category_id IS NOT NULL
			            GROUP BY t.category_id ORDER BY COUNT(*) DESC, t.category_id LIMIT 1)`
		)
		.all(categoryId) as SeriesRow[];
	const view = buildRecurringView(rows, today);
	return [...view.active, ...view.ended];
}

export function categoryDetail(
	db: Database,
	categoryId: number,
	month: string,
	today: string
): CategoryDetail | null {
	const cat = db
		.prepare(
			`SELECT c.id, c.name, c.emoji, g.name AS group_name
			 FROM categories c JOIN category_groups g ON g.id = c.group_id WHERE c.id = ?`
		)
		.get(categoryId) as { id: number; name: string; emoji: string | null; group_name: string } | undefined;
	if (!cat) return null;
	// effective budget/rollover come from the budgets engine — never re-derived
	// (ponytail: budgetMonth computes the whole month; fine at this data size)
	const snap = budgetMonth(db, month);
	const line = [...snap.income.lines, ...snap.groups.flatMap((g) => g.lines)].find(
		(l) => l.category_id === categoryId
	);
	return {
		category_id: cat.id,
		name: cat.name,
		emoji: cat.emoji,
		group_name: cat.group_name,
		protected: isProtectedCategory(cat.name),
		budget_cents: line?.budget_cents ?? 0,
		rollover_cents: line?.rollover_cents ?? null,
		available_cents: line?.available_cents ?? null,
		actual_cents: line?.actual_cents ?? 0,
		trend: spendingTrend(db, categoryId, month),
		series: associatedSeries(db, categoryId, today)
	};
}
