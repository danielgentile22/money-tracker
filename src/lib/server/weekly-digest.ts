import type { Database } from 'better-sqlite3';

// The weekly counterpart of digest.ts: the ONLY payload the Weekly Recap
// narration ever sees (ADR-0001 discipline). Same contract as the monthly
// digest — dollars, ADR-0003 exclusions (transfers and investment activity
// never count), aggregate data-quality counts so narration hedges honestly.
// No fields exist for account numbers, balances, Account names, or identity.

export type WeeklyDigest = {
	week_start: string; // ISO week Monday, 'YYYY-MM-DD'
	week_end: string; // Sunday, inclusive
	summary: WeekFigures;
	previous: WeekFigures; // week-over-week trend basis
	top_categories: { name: string; spent_dollars: number; prev_spent_dollars: number }[];
	top_merchants: { name: string; spent_dollars: number; txn_count: number }[];
	// unusual spends that shouldn't hide inside the total: non-recurring
	// expenses, largest first
	large_one_offs: { date: string; description: string; amount_dollars: number; category: string | null }[];
	data_quality: {
		open_review_items: number;
		unresolved_charges: number;
		rejected_not_reopened: number;
	};
};

type WeekFigures = {
	week_start: string;
	income_dollars: number;
	expenses_dollars: number;
	cash_flow_dollars: number;
	txn_count: number;
};

const dollars = (cents: number) => Math.round(cents) / 100;

/** date ± delta days, pure UTC date-string math (TZ-safe). */
export function shiftDays(date: string, delta: number): string {
	return new Date(Date.parse(date) + delta * 86_400_000).toISOString().slice(0, 10);
}

/** Monday of the ISO week containing `date`. */
export function isoWeekStart(date: string): string {
	const dow = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7; // Mon = 0
	return shiftDays(date, -dow);
}

// [start, end) bounds of the week starting at Monday `weekStart`
const weekEnd = (weekStart: string) => shiftDays(weekStart, 7);

function figures(db: Database, weekStart: string): WeekFigures {
	const row = db
		.prepare(
			`SELECT
			   COALESCE(SUM(CASE WHEN is_transfer = 0 AND amount_cents > 0 THEN amount_cents END), 0) AS income,
			   COALESCE(SUM(CASE WHEN is_transfer = 0 AND amount_cents < 0 THEN -amount_cents END), 0) AS expenses,
			   COALESCE(SUM(is_transfer = 0), 0) AS txn_count
			 FROM transactions
			 WHERE is_investment_activity = 0 AND date >= ? AND date < ?`
		)
		.get(weekStart, weekEnd(weekStart)) as { income: number; expenses: number; txn_count: number };
	return {
		week_start: weekStart,
		income_dollars: dollars(row.income),
		expenses_dollars: dollars(row.expenses),
		cash_flow_dollars: dollars(row.income - row.expenses),
		txn_count: row.txn_count
	};
}

function categorySpend(db: Database, weekStart: string): Map<string, number> {
	const rows = db
		.prepare(
			`SELECT COALESCE(c.name, 'Uncategorized') AS cat_name, SUM(-t.amount_cents) AS spent_cents
			 FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
			 WHERE t.is_investment_activity = 0 AND t.is_transfer = 0 AND t.amount_cents < 0
			   AND t.date >= ? AND t.date < ?
			 GROUP BY cat_name ORDER BY spent_cents DESC`
		)
		.all(weekStart, weekEnd(weekStart)) as { cat_name: string; spent_cents: number }[];
	return new Map(rows.map((r) => [r.cat_name, r.spent_cents]));
}

// ponytail: "large one-off" = non-recurring expense ≥ $100; make it a
// settings knob only if real weeks prove the fixed line wrong.
const ONE_OFF_MIN_CENTS = 10_000;

export function buildWeeklyDigest(db: Database, weekStart: string): WeeklyDigest {
	const prevStart = shiftDays(weekStart, -7);
	const spend = categorySpend(db, weekStart);
	const prevSpend = categorySpend(db, prevStart);

	const merchants = db
		.prepare(
			`SELECT COALESCE(merchant, name) AS name, SUM(-amount_cents) AS spent_cents, COUNT(*) AS txn_count
			 FROM transactions
			 WHERE is_investment_activity = 0 AND is_transfer = 0 AND amount_cents < 0
			   AND date >= ? AND date < ?
			 GROUP BY COALESCE(merchant, name) ORDER BY spent_cents DESC LIMIT 5`
		)
		.all(weekStart, weekEnd(weekStart)) as { name: string; spent_cents: number; txn_count: number }[];

	const oneOffs = db
		.prepare(
			`SELECT t.date, COALESCE(t.merchant, t.name) AS description, -t.amount_cents AS spent_cents,
			        c.name AS category
			 FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
			 WHERE t.is_investment_activity = 0 AND t.is_transfer = 0 AND t.amount_cents < 0
			   AND t.recurring_series_id IS NULL AND -t.amount_cents >= ?
			   AND t.date >= ? AND t.date < ?
			 ORDER BY spent_cents DESC LIMIT 5`
		)
		.all(ONE_OFF_MIN_CENTS, weekStart, weekEnd(weekStart)) as {
		date: string;
		description: string;
		spent_cents: number;
		category: string | null;
	}[];

	const count = (sql: string) => db.prepare(sql).pluck().get() as number;

	return {
		week_start: weekStart,
		week_end: shiftDays(weekStart, 6),
		summary: figures(db, weekStart),
		previous: figures(db, prevStart),
		top_categories: [...spend.entries()].slice(0, 8).map(([name, cents]) => ({
			name,
			spent_dollars: dollars(cents),
			prev_spent_dollars: dollars(prevSpend.get(name) ?? 0)
		})),
		top_merchants: merchants.map((m) => ({
			name: m.name,
			spent_dollars: dollars(m.spent_cents),
			txn_count: m.txn_count
		})),
		large_one_offs: oneOffs.map((o) => ({
			date: o.date,
			description: o.description,
			amount_dollars: dollars(o.spent_cents),
			category: o.category
		})),
		data_quality: {
			open_review_items: count("SELECT COUNT(*) FROM review_items WHERE status = 'open'"),
			unresolved_charges: count(
				'SELECT COUNT(*) FROM transactions WHERE unresolved = 1 AND is_investment_activity = 0'
			),
			rejected_not_reopened: count("SELECT COUNT(*) FROM review_items WHERE status = 'rejected'")
		}
	};
}
