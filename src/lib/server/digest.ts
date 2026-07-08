import type { Database } from 'better-sqlite3';
import { monthSummary, spendingByCategory } from './analytics';
import { activeConcerns } from './concerns';
import { runRateProjection, counterfactual, plans529 } from './projections';

// The digest is the ONLY payload Claude's narration ever sees (ADR-0001 egress
// channel #2 — this type is the contract). It physically has no fields for
// account numbers, balances, Account names, or identity: 529 plans appear as
// horizons and percentages, never dollars-in-an-account or a beneficiary's name.
// If a future feature wants Claude to see more, the change happens HERE, in
// the boundary test, and in ADR-0001 — never inline in a prompt.

export type Digest = {
	period: string; // 'YYYY-MM'
	months_of_history: number;
	summary: MonthFigures;
	previous: MonthFigures; // month-over-month trend basis
	top_categories: { name: string; spent_dollars: number; prev_spent_dollars: number }[];
	top_merchants: { name: string; spent_dollars: number; txn_count: number }[];
	concerns: { title: string; severity: number; figures: Record<string, number | string> }[];
	projections: {
		run_rate:
			| { monthly_net_dollars: number; twelve_month_dollars: number; assumptions: string[] }
			| { insufficient: true };
		fix_these_and_save: {
			monthly_dollars: number;
			annual_dollars: number;
			lines: { title: string; overage_dollars: number }[];
			assumptions: string[];
		};
		education_plans: {
			years_left: number;
			funded_pct: number;
			monthly_contribution_dollars: number;
			contribution_source: string;
			assumptions: string[];
		}[];
	};
	// aggregate counts only — so narration hedges figures the owner's data
	// hygiene backlog still moves (an unhedged savings rate would mislead today)
	data_quality: {
		open_review_items: number;
		unresolved_charges: number;
		rejected_not_reopened: number;
	};
};

type MonthFigures = {
	month: string;
	income_dollars: number;
	expenses_dollars: number;
	cash_flow_dollars: number;
	saved_dollars: number;
	savings_rate_pct: number | null;
};

const dollars = (cents: number) => Math.round(cents) / 100;

function figures(db: Database, month: string): MonthFigures {
	const s = monthSummary(db, month);
	return {
		month: s.month,
		income_dollars: dollars(s.income_cents),
		expenses_dollars: dollars(s.expenses_cents),
		cash_flow_dollars: dollars(s.cash_flow_cents),
		saved_dollars: dollars(s.saved_cents),
		savings_rate_pct: s.savings_rate == null ? null : Math.round(s.savings_rate * 1000) / 10
	};
}

function prevMonth(month: string): string {
	const [y, m] = month.split('-').map(Number);
	return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

export function buildDigest(db: Database, period: string, today: string): Digest {
	const prev = prevMonth(period);
	const prevSpend = new Map(
		spendingByCategory(db, prev).map((c) => [c.name ?? 'Uncategorized', c.spent_cents])
	);
	const merchants = db
		.prepare(
			`SELECT COALESCE(merchant, name) AS name, SUM(-amount_cents) AS spent_cents, COUNT(*) AS txn_count
			 FROM transactions
			 WHERE is_investment_activity = 0 AND is_transfer = 0 AND amount_cents < 0
			   AND date >= ? AND date < ?
			 GROUP BY COALESCE(merchant, name) ORDER BY spent_cents DESC LIMIT 8`
		)
		.all(`${period}-01`, nextMonthStart(period)) as {
		name: string;
		spent_cents: number;
		txn_count: number;
	}[];

	const runRate = runRateProjection(db, today);
	const fix = counterfactual(db);
	const monthsOfHistory = db
		.prepare(
			`SELECT COUNT(DISTINCT substr(date, 1, 7)) FROM transactions WHERE is_investment_activity = 0`
		)
		.pluck()
		.get() as number;

	return {
		period,
		months_of_history: monthsOfHistory,
		summary: figures(db, period),
		previous: figures(db, prev),
		top_categories: spendingByCategory(db, period)
			.slice(0, 8)
			.map((c) => ({
				name: c.name ?? 'Uncategorized',
				spent_dollars: dollars(c.spent_cents),
				prev_spent_dollars: dollars(prevSpend.get(c.name ?? 'Uncategorized') ?? 0)
			})),
		top_merchants: merchants.map((m) => ({
			name: m.name,
			spent_dollars: dollars(m.spent_cents),
			txn_count: m.txn_count
		})),
		concerns: activeConcerns(db).map((c) => ({
			title: c.title,
			severity: c.severity,
			figures: JSON.parse(c.figures) as Record<string, number | string>
		})),
		projections: {
			run_rate: runRate.insufficient
				? { insufficient: true }
				: {
						monthly_net_dollars: dollars(runRate.monthly_net_cents),
						twelve_month_dollars: dollars(runRate.twelve_month_cents),
						assumptions: runRate.assumptions
					},
			fix_these_and_save: {
				monthly_dollars: dollars(fix.monthly_cents),
				annual_dollars: dollars(fix.annual_cents),
				lines: fix.lines.map((l) => ({ title: l.title, overage_dollars: dollars(l.overage_cents) })),
				assumptions: fix.assumptions
			},
			education_plans: plans529(db, today).flatMap((p) =>
				'needsSetup' in p
					? []
					: [
							{
								years_left: p.years_left,
								funded_pct: p.funded_pct,
								monthly_contribution_dollars: dollars(p.monthly_contribution_cents),
								contribution_source: p.contribution_source,
								assumptions: p.assumptions
							}
						]
			)
		},
		data_quality: {
			open_review_items: count(db, "SELECT COUNT(*) FROM review_items WHERE status = 'open'"),
			unresolved_charges: count(
				db,
				'SELECT COUNT(*) FROM transactions WHERE unresolved = 1 AND is_investment_activity = 0'
			),
			rejected_not_reopened: count(
				db,
				"SELECT COUNT(*) FROM review_items WHERE status = 'rejected'"
			)
		}
	};
}

function nextMonthStart(month: string): string {
	const [y, m] = month.split('-').map(Number);
	return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

function count(db: Database, sql: string): number {
	return db.prepare(sql).pluck().get() as number;
}
