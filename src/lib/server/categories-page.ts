// Categories page engine (ADR-0008): one Month cursor governs the whole page.
// Everything here composes the existing engines — budgetMonth for the list,
// cashFlow for the Sankey — so no number can disagree with them.

import type { Database } from 'better-sqlite3';
import { budgetMonth, type BudgetMonth } from './budgets';
import { spendingByCategory } from './analytics';
import { cashFlow, type CashFlow } from './cashflow';
import { usageByCategory, type CategoryUsage } from './categories';
import { groupedCategories } from './groups';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** URL ?month → cursor month; invalid or missing falls back to today's month. */
export function monthCursor(param: string | null, today: string): string {
	return param && MONTH_RE.test(param) ? param : today.slice(0, 7);
}

export type CategoriesMonth = {
	snapshot: BudgetMonth; // groups and lines re-ranked by actual spend, biggest first
	uncategorized_cents: number;
	flow: CashFlow; // Sankey for the same month — no FilterSet reaches the URL (ADR-0008)
	usage: Record<number, CategoryUsage>; // slice 5: Delete says what the re-home moves
};

/** Everything the /categories page shows for one cursor month. */
export function categoriesMonth(db: Database, month: string): CategoriesMonth {
	const snapshot = budgetMonth(db, month);
	for (const g of snapshot.groups) g.lines.sort((a, b) => b.actual_cents - a.actual_cents);
	snapshot.groups.sort((a, b) => b.actual_cents - a.actual_cents);
	// budgetMonth builds groups from their spending lines, so a Group with no
	// lines (empty, or holding only the line-less 'Transfer') never surfaces —
	// but the manager must reach every Group (rename, delete, reorder).
	// 'Income' stays out of the expense list, matching the engine's own split.
	const known = new Set(snapshot.groups.map((g) => g.group_id));
	for (const g of groupedCategories(db))
		if (!known.has(g.id) && g.name !== 'Income')
			snapshot.groups.push({
				group_id: g.id,
				name: g.name,
				emoji: g.emoji,
				lines: [],
				budget_cents: 0,
				actual_cents: 0
			});
	const uncategorized =
		spendingByCategory(db, month).find((r) => r.category_id === null)?.spent_cents ?? 0;
	// '-31' is a safe inclusive bound: stored dates are real days, so string
	// comparison never admits a neighboring month.
	const flow = cashFlow(db, { date: { from: `${month}-01`, to: `${month}-31` } });
	const all = usageByCategory(db);
	const none: CategoryUsage = { txns: 0, rules: 0, mappings: 0, budgets: 0 };
	const lines = [...snapshot.income.lines, ...snapshot.groups.flatMap((g) => g.lines)];
	const usage = Object.fromEntries(lines.map((l) => [l.category_id, all[l.category_id] ?? none]));
	return { snapshot, uncategorized_cents: uncategorized, flow, usage };
}
