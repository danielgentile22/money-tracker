import type { Database } from 'better-sqlite3';
import { compileFilters, resolveDateRange, type FilterSet } from './filters';
import { monthRange, shiftMonth } from './analytics';
import { localToday, netWorthSeries, type SeriesPoint } from './balances';
import { queryLedger, type LedgerRow } from './ledger';

// Monarch Session 3: the report engine. One call returns everything a Reports
// tab renders, so every number on the page comes from the same math. Spending
// and income are the same query under a sign discipline; Transfers never
// count and investment activity is invisible (ADR-0003, via compileFilters).

export type ReportTab = 'spending' | 'income';
export type GroupBy = 'group' | 'category' | 'merchant' | 'tag';

export type BreakdownRow = {
	id: number | string | null; // dimension id (merchant: its name; null: uncategorized/untagged)
	label: string;
	amount_cents: number; // positive magnitude
	share: number; // of the filtered total
};

export type ReportData = {
	months: { month: string; total_cents: number }[]; // zero-filled over the resolved range
	breakdown: BreakdownRow[]; // sorted descending
	stats: { total_cents: number; monthly_avg_cents: number; txn_count: number };
	rows: LedgerRow[]; // drill-down page
	hasMore: boolean;
};

const SIGN = {
	spending: { cond: 't.is_transfer = 0 AND t.amount_cents < 0', sum: '-t.amount_cents' },
	income: { cond: 't.is_transfer = 0 AND t.amount_cents > 0', sum: 't.amount_cents' }
} as const;

/** Months the filter resolves to; 'all' stretches from the first matching row to today. */
function resolvedMonths(
	db: Database,
	f: FilterSet,
	today: string,
	where: string,
	params: (string | number)[]
): string[] {
	const { from, to } = resolveDateRange(f.date, today);
	const thisMonth = today.slice(0, 7);
	let fromMonth = from?.slice(0, 7);
	if (!fromMonth) {
		fromMonth =
			(db
				.prepare(`SELECT MIN(substr(t.date, 1, 7)) FROM transactions t WHERE ${where}`)
				.pluck()
				.get(...params) as string | null) ?? thisMonth;
	}
	const toMonth = to?.slice(0, 7) ?? thisMonth;
	return monthRange(fromMonth, toMonth < fromMonth ? fromMonth : toMonth);
}

const BREAKDOWN: Record<GroupBy, { select: string; joins: string; key: string }> = {
	group: {
		select: 'g.id AS id, g.name AS label',
		joins: `LEFT JOIN categories c ON c.id = t.category_id
		        LEFT JOIN category_groups g ON g.id = c.group_id`,
		key: 'g.id'
	},
	category: {
		select: 'c.id AS id, c.name AS label',
		joins: 'LEFT JOIN categories c ON c.id = t.category_id',
		key: 'c.id'
	},
	merchant: {
		select: 'COALESCE(t.merchant, t.name) AS id, COALESCE(t.merchant, t.name) AS label',
		joins: '',
		key: 'COALESCE(t.merchant, t.name)'
	},
	// a Transaction with two Tags counts under both — shares stay relative to
	// the filtered total, so the tag breakdown may sum past 100% by design
	tag: {
		select: 'tg.id AS id, tg.name AS label',
		joins: `LEFT JOIN transaction_tags tt ON tt.transaction_id = t.id
		        LEFT JOIN tags tg ON tg.id = tt.tag_id`,
		key: 'tg.id'
	}
};

export function reportData(
	db: Database,
	f: FilterSet,
	tab: ReportTab,
	groupBy: GroupBy,
	opts: { today?: string; page?: number; pageSize?: number } = {}
): ReportData {
	const today = opts.today ?? localToday();
	const sign = SIGN[tab];
	const { clauses, params } = compileFilters(f, today);
	const where = `${clauses.join(' AND ')} AND ${sign.cond}`;

	const months = resolvedMonths(db, f, today, where, params);
	const series = db
		.prepare(
			`SELECT substr(t.date, 1, 7) AS month, SUM(${sign.sum}) AS total_cents
			 FROM transactions t WHERE ${where} GROUP BY month`
		)
		.all(...params) as { month: string; total_cents: number }[];
	const byMonth = new Map(series.map((r) => [r.month, r.total_cents]));

	const stats = db
		.prepare(
			`SELECT COALESCE(SUM(${sign.sum}), 0) AS total_cents, COUNT(*) AS txn_count
			 FROM transactions t WHERE ${where}`
		)
		.get(...params) as { total_cents: number; txn_count: number };

	const b = BREAKDOWN[groupBy];
	const breakdown = (
		db
			.prepare(
				`SELECT ${b.select}, SUM(${sign.sum}) AS amount_cents
				 FROM transactions t ${b.joins} WHERE ${where}
				 GROUP BY ${b.key} ORDER BY amount_cents DESC`
			)
			.all(...params) as { id: number | string | null; label: string | null; amount_cents: number }[]
	).map((r) => ({
		id: r.id,
		label: r.label ?? (groupBy === 'tag' ? 'Untagged' : 'Uncategorized'),
		amount_cents: r.amount_cents,
		share: stats.total_cents > 0 ? r.amount_cents / stats.total_cents : 0
	}));

	const pageSize = opts.pageSize ?? 50;
	const rows = queryLedger(db, f, {
		sign: tab,
		today,
		limit: pageSize + 1,
		offset: ((opts.page ?? 1) - 1) * pageSize
	});

	// The monthly average must span only COMPLETE months: not the in-progress
	// current month, and not a month the resolved range clips at either end
	// (a custom mid-month from/to). Sum just those months' spend over their
	// count, so neither numerator nor divisor is contaminated by partial data
	// (#65). Fall back to the raw mean when no month is complete.
	const { from, to } = resolveDateRange(f.date, today);
	const thisMonth = today.slice(0, 7);
	// last calendar day of month m (day before the next month's first)
	const monthEnd = (m: string) =>
		new Date(Date.parse(`${shiftMonth(m, 1)}-01`) - 86_400_000).toISOString().slice(0, 10);
	const monthComplete = (m: string) =>
		m < thisMonth && // not the in-progress month
		(!from || from <= `${m}-01`) && // range doesn't clip the month's start
		(!to || to >= monthEnd(m)); // range covers through the month's end
	const completeMonths = months.filter(monthComplete);
	const completeTotal = completeMonths.reduce((s, m) => s + (byMonth.get(m) ?? 0), 0);
	const monthly_avg_cents = completeMonths.length
		? Math.round(completeTotal / completeMonths.length)
		: Math.round(stats.total_cents / Math.max(1, months.length));

	return {
		months: months.map((month) => ({ month, total_cents: byMonth.get(month) ?? 0 })),
		breakdown,
		stats: {
			total_cents: stats.total_cents,
			monthly_avg_cents,
			txn_count: stats.txn_count
		},
		rows: rows.slice(0, pageSize),
		hasMore: rows.length > pageSize
	};
}

/**
 * Net worth tab: the existing snapshot series windowed to the filter's date
 * range. Of the filter dimensions only Account applies — the rest are
 * meaningless for balances and are ignored. No new balance math.
 */
export function netWorthReport(db: Database, f: FilterSet, today = localToday()): SeriesPoint[] {
	let accountIds: number[] | undefined;
	if (f.accounts?.include?.length || f.accounts?.exclude?.length) {
		const all = db.prepare('SELECT id FROM accounts').pluck().all() as number[];
		const inc = f.accounts.include;
		const exc = f.accounts.exclude;
		accountIds = all.filter((id) => (!inc || inc.includes(id)) && !exc?.includes(id));
	}
	const { from, to } = resolveDateRange(f.date, today);
	return netWorthSeries(db, accountIds).filter(
		(p) => (!from || p.date >= from) && (!to || p.date <= to)
	);
}

/** Donut slices: the top N breakdown rows plus a computed "other" rollup. */
export function donutSlices(breakdown: BreakdownRow[], top = 8): BreakdownRow[] {
	if (breakdown.length <= top) return breakdown;
	const head = breakdown.slice(0, top);
	const rest = breakdown.slice(top);
	return [
		...head,
		{
			id: null,
			label: 'Other',
			amount_cents: rest.reduce((s, r) => s + r.amount_cents, 0),
			share: rest.reduce((s, r) => s + r.share, 0)
		}
	];
}
