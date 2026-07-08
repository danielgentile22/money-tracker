import type { Database } from 'better-sqlite3';
import { incomeByCategory, monthRange, shiftMonth, spendingByCategory } from './analytics';

// Budgets v2 (Monarch Session 2): per-month budget rows with fill-forward —
// the effective budget for month M is the row with the greatest month <= M;
// zero rows end the fill-forward (zero and unbudgeted are the same to the
// math). Past months are frozen facts. One engine call (budgetMonth) returns
// everything the page renders, so no two numbers can disagree.

// Flex mode (budget_mode setting, flex_pool table, categories.flex column) is
// retired — ADR-0008. The data stays in the DB; nothing here reads it.

// ---------- store ----------

export function setBudget(db: Database, categoryId: number, month: string, cents: number): void {
	db.prepare(
		`INSERT INTO budgets (category_id, month, amount_cents) VALUES (?, ?, ?)
		 ON CONFLICT (category_id, month) DO UPDATE SET amount_cents = excluded.amount_cents`
	).run(categoryId, month, cents);
}

/** Clearing writes an explicit zero row: history-safe removal from this month on. */
export function clearBudget(db: Database, categoryId: number, month: string): void {
	setBudget(db, categoryId, month, 0);
}

/**
 * Rollover toggle: non-null month anchors the balance at $0 that month; null
 * turns it off. Re-anchoring (off then on, or straight overwrite) IS the reset.
 */
export function setRolloverAnchor(db: Database, categoryId: number, month: string | null): void {
	db.prepare('UPDATE categories SET rollover_anchor = ? WHERE id = ?').run(month, categoryId);
}

// ---------- fill-forward resolution ----------

/** category_id → effective budget cents for the month (fill-forward, zeros kept). */
function effectiveBudgets(db: Database, month: string): Map<number, number> {
	const rows = db
		.prepare(
			`SELECT category_id, amount_cents FROM budgets b
			 WHERE month = (SELECT MAX(month) FROM budgets b2
			                WHERE b2.category_id = b.category_id AND b2.month <= ?)`
		)
		.all(month) as { category_id: number; amount_cents: number }[];
	return new Map(rows.map((r) => [r.category_id, r.amount_cents]));
}

/**
 * Balance entering `month`: Σ over [anchor, month−1] of (effective budget −
 * actual), surplus and shortfall alike. Only months < `month` contribute, so
 * editing a later budget can never rewrite an earlier balance.
 */
function rolloverBalance(db: Database, categoryId: number, anchor: string, month: string): number {
	const prev = shiftMonth(month, -1);
	if (anchor > prev) return 0; // anchor month itself starts at $0
	const budgetRows = db
		.prepare('SELECT month, amount_cents FROM budgets WHERE category_id = ? AND month <= ? ORDER BY month')
		.all(categoryId, prev) as { month: string; amount_cents: number }[];
	const spentRows = db
		.prepare(
			`SELECT substr(date, 1, 7) AS month, SUM(-amount_cents) AS spent
			 FROM transactions
			 WHERE is_investment_activity = 0 AND is_transfer = 0 AND amount_cents < 0
			   AND category_id = ? AND date >= ? AND date < ?
			 GROUP BY month`
		)
		.all(categoryId, `${anchor}-01`, `${month}-01`) as { month: string; spent: number }[];
	const spent = new Map(spentRows.map((r) => [r.month, r.spent]));
	let balance = 0;
	let i = 0;
	let effective = 0;
	for (const m of monthRange(anchor, prev)) {
		while (i < budgetRows.length && budgetRows[i].month <= m) effective = budgetRows[i++].amount_cents;
		balance += effective - (spent.get(m) ?? 0);
	}
	return balance;
}

// ---------- engine ----------

export type BudgetLine = {
	category_id: number;
	name: string;
	emoji: string | null;
	budget_cents: number; // effective; 0 = unbudgeted (render blank)
	actual_cents: number; // spend for expenses, income for the Income section
	rollover_anchor: string | null;
	/** Balance entering the month; null when rollover is off (or anchored after this month). */
	rollover_cents: number | null;
	/** budget + rollover − actual; null when rollover is off. */
	available_cents: number | null;
};

export type BudgetGroupSection = {
	group_id: number;
	name: string;
	emoji: string | null;
	lines: BudgetLine[];
	budget_cents: number;
	actual_cents: number;
};

export type BudgetMonth = {
	month: string;
	income: { lines: BudgetLine[]; expected_cents: number; actual_cents: number };
	groups: BudgetGroupSection[]; // enabled expense Categories by Group (Income group and Transfer excluded)
	allocated_cents: number; // sum of all expense budgets
	left_to_budget_cents: number; // expected income − allocations; positive slack is the savings plan
};

/** The whole page in one call — every number on /budgets comes from this snapshot. */
export function budgetMonth(db: Database, month: string): BudgetMonth {
	const budgets = effectiveBudgets(db, month);
	const spend = new Map(spendingByCategory(db, month).map((r) => [r.category_id, r.spent_cents]));
	const income = new Map(incomeByCategory(db, month).map((r) => [r.category_id, r.income_cents]));

	const cats = db
		.prepare(
			`SELECT c.id, c.name, c.emoji, c.rollover_anchor, g.id AS group_id,
			        g.name AS group_name, g.emoji AS group_emoji
			 FROM categories c JOIN category_groups g ON g.id = c.group_id
			 WHERE c.disabled = 0
			 ORDER BY g.sort_order, g.id, c.sort_order, c.id`
		)
		.all() as {
		id: number; name: string; emoji: string | null;
		rollover_anchor: string | null; group_id: number; group_name: string; group_emoji: string | null;
	}[];

	const line = (c: (typeof cats)[number], actual: number): BudgetLine => {
		const budget = budgets.get(c.id) ?? 0;
		const anchored = c.rollover_anchor !== null && c.rollover_anchor <= month;
		const rollover = anchored ? rolloverBalance(db, c.id, c.rollover_anchor!, month) : null;
		return {
			category_id: c.id, name: c.name, emoji: c.emoji,
			budget_cents: budget, actual_cents: actual,
			rollover_anchor: c.rollover_anchor,
			rollover_cents: rollover,
			available_cents: rollover === null ? null : budget + rollover - actual
		};
	};

	const incomeLines = cats
		.filter((c) => c.group_name === 'Income')
		.map((c) => line(c, income.get(c.id) ?? 0));
	const expected = incomeLines.reduce((s, l) => s + l.budget_cents, 0);

	const groups: BudgetGroupSection[] = [];
	for (const c of cats) {
		if (c.group_name === 'Income' || c.name === 'Transfer') continue;
		let g = groups[groups.length - 1];
		if (!g || g.group_id !== c.group_id) {
			g = { group_id: c.group_id, name: c.group_name, emoji: c.group_emoji, lines: [], budget_cents: 0, actual_cents: 0 };
			groups.push(g);
		}
		const l = line(c, spend.get(c.id) ?? 0);
		g.lines.push(l);
		g.budget_cents += l.budget_cents;
		g.actual_cents += l.actual_cents;
	}

	const allocated = groups.flatMap((g) => g.lines).reduce((s, l) => s + l.budget_cents, 0);

	return {
		month,
		income: {
			lines: incomeLines,
			expected_cents: expected,
			actual_cents: incomeLines.reduce((s, l) => s + l.actual_cents, 0)
		},
		groups,
		allocated_cents: allocated,
		left_to_budget_cents: expected - allocated
	};
}

// ---------- detector compat ----------

export type BudgetStatus = {
	category_id: number;
	name: string;
	target_cents: number; // effective budget (field name kept for stored Concern figures)
	actual_cents: number;
};

/** Every Category with a non-zero effective budget and its month-to-date spend. */
export function budgetStatus(db: Database, month: string): BudgetStatus[] {
	const actuals = new Map(spendingByCategory(db, month).map((c) => [c.category_id, c.spent_cents]));
	const out: BudgetStatus[] = [];
	for (const [category_id, target_cents] of effectiveBudgets(db, month)) {
		if (target_cents <= 0) continue;
		const name = db.prepare('SELECT name FROM categories WHERE id = ?').pluck().get(category_id) as string;
		out.push({ category_id, name, target_cents, actual_cents: actuals.get(category_id) ?? 0 });
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}
