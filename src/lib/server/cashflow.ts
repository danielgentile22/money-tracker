import type { Database } from 'better-sqlite3';
import { compileFilters, resolveDateRange, type FilterSet } from './filters';
import { monthRange } from './analytics';
import { localToday } from './balances';

// Monarch Session 3, Pass B: the cash-flow engine — since slice 5 its one
// consumer is the Categories page's month Sankey (nodes/links; the /cash-flow
// page it was built for now redirects there). Income Categories → spine →
// expense Groups, with an explicit Savings or Shortfall ribbon. Conservation
// holds by construction: flow into the spine equals flow out, and the savings
// rate IS the Savings ribbon over income — the numbers cannot contradict
// themselves.
//
// This is deliberately NOT the is_saved metric ("moved to savings"): that one
// counts explicit contributions; this one counts what was left over.

export type SankeyNode = {
	id: string;
	label: string;
	kind: 'income' | 'spine' | 'group' | 'savings' | 'shortfall';
	// ribbon click applies this filter (drill-down via the engine, not in-diagram)
	filterKind?: 'categories' | 'groups';
	filterId?: number;
};
export type SankeyLink = { source: string; target: string; value_cents: number };

export type CashFlow = {
	nodes: SankeyNode[];
	links: SankeyLink[];
	months: { month: string; income_cents: number; expenses_cents: number }[];
	income_cents: number;
	expenses_cents: number;
	savings_rate: number | null; // (income − expenses) / income; null on zero income
};

export function cashFlow(db: Database, f: FilterSet, today = localToday()): CashFlow {
	const { clauses, params } = compileFilters(f, today);
	const base = `${clauses.join(' AND ')} AND t.is_transfer = 0`;

	const income = db
		.prepare(
			`SELECT c.id, COALESCE(c.name, 'Uncategorized') AS label, SUM(t.amount_cents) AS value_cents
			 FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
			 WHERE ${base} AND t.amount_cents > 0
			 GROUP BY c.id ORDER BY value_cents DESC`
		)
		.all(...params) as { id: number | null; label: string; value_cents: number }[];

	const expenses = db
		.prepare(
			`SELECT g.id, COALESCE(g.name, 'Uncategorized') AS label, SUM(-t.amount_cents) AS value_cents
			 FROM transactions t
			 LEFT JOIN categories c ON c.id = t.category_id
			 LEFT JOIN category_groups g ON g.id = c.group_id
			 WHERE ${base} AND t.amount_cents < 0
			 GROUP BY g.id ORDER BY value_cents DESC`
		)
		.all(...params) as { id: number | null; label: string; value_cents: number }[];

	const incomeTotal = income.reduce((s, r) => s + r.value_cents, 0);
	const expenseTotal = expenses.reduce((s, r) => s + r.value_cents, 0);
	const residual = incomeTotal - expenseTotal;

	const nodes: SankeyNode[] = [
		...income.map((r) => ({
			id: `in:${r.id ?? 'null'}`,
			label: r.label,
			kind: 'income' as const,
			...(r.id != null && { filterKind: 'categories' as const, filterId: r.id })
		})),
		{ id: 'spine', label: 'Cash flow', kind: 'spine' },
		...expenses.map((r) => ({
			id: `out:${r.id ?? 'null'}`,
			label: r.label,
			kind: 'group' as const,
			...(r.id != null && { filterKind: 'groups' as const, filterId: r.id })
		}))
	];
	const links: SankeyLink[] = [
		...income.map((r) => ({ source: `in:${r.id ?? 'null'}`, target: 'spine', value_cents: r.value_cents })),
		...expenses.map((r) => ({ source: 'spine', target: `out:${r.id ?? 'null'}`, value_cents: r.value_cents }))
	];
	if (residual > 0) {
		// income that wasn't spent: keeping money is a flow, not an absence
		nodes.push({ id: 'savings', label: 'Savings', kind: 'savings' });
		links.push({ source: 'spine', target: 'savings', value_cents: residual });
	} else if (residual < 0) {
		// over-spent period, rendered honestly: a Shortfall source feeds the spine
		nodes.push({ id: 'shortfall', label: 'Shortfall', kind: 'shortfall' });
		links.push({ source: 'shortfall', target: 'spine', value_cents: -residual });
	}

	// monthly bars: zero-filled over the resolved range ('all' stretches from
	// the first matching row — same convention as the report engine)
	const { from, to } = resolveDateRange(f.date, today);
	const series = db
		.prepare(
			`SELECT substr(t.date, 1, 7) AS month,
			        COALESCE(SUM(CASE WHEN t.amount_cents > 0 THEN t.amount_cents END), 0) AS income_cents,
			        COALESCE(SUM(CASE WHEN t.amount_cents < 0 THEN -t.amount_cents END), 0) AS expenses_cents
			 FROM transactions t WHERE ${base} GROUP BY month ORDER BY month`
		)
		.all(...params) as { month: string; income_cents: number; expenses_cents: number }[];
	const thisMonth = today.slice(0, 7);
	const fromMonth = from?.slice(0, 7) ?? series[0]?.month ?? thisMonth;
	const toMonth = to?.slice(0, 7) ?? thisMonth;
	const byMonth = new Map(series.map((r) => [r.month, r]));
	const months = monthRange(fromMonth, toMonth < fromMonth ? fromMonth : toMonth).map(
		(month) => byMonth.get(month) ?? { month, income_cents: 0, expenses_cents: 0 }
	);

	return {
		nodes,
		links,
		months,
		income_cents: incomeTotal,
		expenses_cents: expenseTotal,
		savings_rate: incomeTotal > 0 ? residual / incomeTotal : null
	};
}
