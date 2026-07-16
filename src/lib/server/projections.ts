import type { Database } from 'better-sqlite3';
import { monthSummary, fullMonthsOfHistory, MIN_FULL_MONTHS } from './analytics';
import { fmtUSD } from '../money';

// Projections (PRD Phase 2): deterministic arithmetic with the assumptions
// printed next to the numbers — never produced by anything but this math
// (CONTEXT.md; an Insight may narrate them in Phase 3, never compute them).

export type Insufficient = { insufficient: true; needMonths: number; haveMonths: number };

export type RunRate = {
	insufficient?: false;
	base_avg_cents: number; // trailing-3-full-month average net (income − expenses)
	recurring_delta_cents: number; // known recurring price changes, monthly-ized
	monthly_net_cents: number;
	twelve_month_cents: number;
	months: { month: string; projected_cents: number }[];
	assumptions: string[];
};

function shiftMonth(month: string, delta: number): string {
	const [y, m] = month.split('-').map(Number);
	const n = y * 12 + (m - 1) + delta;
	return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`;
}

const monthName = (month: string) =>
	new Date(`${month}-15T00:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

/** Per-cadence factor to a monthly rate. */
const MONTHLYIZE: Record<string, number> = { weekly: 52 / 12, monthly: 1, annual: 1 / 12 };

export function runRateProjection(db: Database, today: string): RunRate | Insufficient {
	const have = fullMonthsOfHistory(db, today);
	if (have < MIN_FULL_MONTHS) return { insufficient: true, needMonths: MIN_FULL_MONTHS, haveMonths: have };

	const month = today.slice(0, 7);
	const window = [-3, -2, -1].map((d) => shiftMonth(month, d));
	const nets = window.map((m) => monthSummary(db, m).cash_flow_cents);
	const baseAvg = Math.round(nets.reduce((a, b) => a + b, 0) / 3);

	// recurring price changes not yet fully absorbed by the trailing average:
	// each series keeps billing its latest amount, the average embeds its typical.
	// But any new-price bills ALREADY inside the window are partly in baseAvg, so
	// carrying the full (last − typical) double counts them (#52). Discount by the
	// new-price occurrences in the window: (monthlyize − n_new/3) — a fully
	// caught-up series (n_new = 3·monthlyize) contributes nothing.
	const changed = db
		.prepare(
			`SELECT rs.merchant, rs.cadence, rs.typical_amount_cents, rs.last_amount_cents,
			   (SELECT COUNT(*) FROM transactions t
			    WHERE t.recurring_series_id = rs.id AND -t.amount_cents = rs.last_amount_cents
			      AND t.date >= ? AND t.date < ?) AS n_new
			 FROM recurring_series rs WHERE rs.last_amount_cents != rs.typical_amount_cents`
		)
		.all(`${window[0]}-01`, `${month}-01`) as {
		merchant: string; cadence: string; typical_amount_cents: number; last_amount_cents: number; n_new: number;
	}[];
	const delta =
		-Math.round(
			changed.reduce(
				(sum, s) =>
					sum + (s.last_amount_cents - s.typical_amount_cents) * ((MONTHLYIZE[s.cadence] ?? 1) - s.n_new / 3),
				0
			)
		) || 0; // never −0

	const monthlyNet = baseAvg + delta;
	const months = Array.from({ length: 12 }, (_, i) => ({
		month: shiftMonth(month, i + 1),
		projected_cents: monthlyNet
	}));

	const assumptions = [
		`Based on the ${monthName(window[0])}–${monthName(window[2])} average net (income − expenses) of ${fmtUSD(baseAvg)}/mo; Transfers excluded per ADR-0003.`,
		...changed.map(
			(s) =>
				`${s.merchant} now bills ${fmtUSD(s.last_amount_cents)} (was ${fmtUSD(s.typical_amount_cents)}) per ${s.cadence === 'annual' ? 'year' : s.cadence === 'weekly' ? 'week' : 'month'} — carried forward.`
		),
		'Assumes income and spending patterns otherwise continue unchanged.'
	];

	return {
		base_avg_cents: baseAvg,
		recurring_delta_cents: delta,
		monthly_net_cents: monthlyNet,
		twelve_month_cents: monthlyNet * 12,
		months,
		assumptions
	};
}

// --- 529 college funding, per beneficiary ---

export type Input529 = {
	account_id: number;
	account_name: string;
	beneficiary: string;
	age: number;
	target_cents: number;
	balance_cents: number;
	monthly_contribution_cents: number;
	contribution_source: 'detected' | 'override' | 'none';
};

export type Plan529 = {
	account_id: number;
	account_name: string;
	beneficiary: string;
	college_year: number;
	years_left: number;
	target_cents: number;
	monthly_contribution_cents: number;
	contribution_source: Input529['contribution_source'];
	projected_cents: number;
	funded_pct: number;
	gap_cents: number; // positive = shortfall
	path: { year: number; balance_cents: number }[];
	assumptions: string[];
};

export type NeedsSetup529 = { needsSetup: true; account_id: number; account_name: string };

/** Annual compounding with contributions added at year end — hand-checkable. */
export function project529(
	input: Input529,
	opts: { returnPct: number; todayYear: number }
): Plan529 {
	const yearsLeft = Math.max(0, 18 - input.age);
	const collegeYear = opts.todayYear + yearsLeft;
	const r = opts.returnPct / 100;
	const path = [{ year: opts.todayYear, balance_cents: input.balance_cents }];
	let bal = input.balance_cents;
	for (let y = opts.todayYear + 1; y <= collegeYear; y++) {
		bal = Math.round(bal * (1 + r)) + input.monthly_contribution_cents * 12;
		path.push({ year: y, balance_cents: bal });
	}
	const source =
		input.contribution_source === 'override'
			? `${fmtUSD(input.monthly_contribution_cents)}/mo contributions from the manual override in Settings.`
			: input.contribution_source === 'detected'
				? `${fmtUSD(input.monthly_contribution_cents)}/mo contributions detected from saved transfer legs (trailing 3-month average, split evenly across 529 Accounts) — continued until ${collegeYear}.`
				: 'No ongoing contributions detected or configured — growth only.';
	return {
		account_id: input.account_id,
		account_name: input.account_name,
		beneficiary: input.beneficiary,
		college_year: collegeYear,
		years_left: yearsLeft,
		target_cents: input.target_cents,
		monthly_contribution_cents: input.monthly_contribution_cents,
		contribution_source: input.contribution_source,
		projected_cents: bal,
		funded_pct: input.target_cents > 0 ? (bal / input.target_cents) * 100 : 0,
		gap_cents: Math.max(0, input.target_cents - bal),
		path,
		assumptions: [
			`Assumed return ${opts.returnPct}%/yr (Settings), compounded annually.`,
			source,
			`College year ${collegeYear} = age 18 from age ${input.age} today; target cost ${fmtUSD(input.target_cents)}.`
		]
	};
}

// --- counterfactual savings ---

export type Counterfactual = {
	monthly_cents: number;
	annual_cents: number;
	lines: { concern_id: number; detector: string; title: string; overage_cents: number }[];
	assumptions: string[];
};

/** "Fix these, save ≈$Z/yr": annualizes the live overage-type Concerns. */
export function counterfactual(db: Database): Counterfactual {
	const rows = db
		.prepare(
			`SELECT id, detector, title, figures, subject FROM concerns
			 WHERE status = 'active' AND detector IN ('budget-overage', 'spend-spike')
			 ORDER BY severity DESC`
		)
		.all() as { id: number; detector: string; title: string; figures: string; subject: string }[];
	const lines = rows.map((r) => {
		const f = JSON.parse(r.figures) as Record<string, number>;
		const overage =
			r.detector === 'budget-overage' ? f.overage_cents : f.mtd_cents - f.avg_cents;
		return { concern_id: r.id, detector: r.detector, title: r.title, subject: r.subject, overage_cents: overage };
	});
	// budget-overage and spend-spike both key on `category:<id>` and describe
	// largely the same dollars — a spike usually causes the overage. Counting
	// both would inflate the total up to 2×, so the total keeps only the larger
	// overage per subject; the lines still list both for the owner (#15).
	const maxBySubject = new Map<string, number>();
	for (const l of lines)
		maxBySubject.set(l.subject, Math.max(maxBySubject.get(l.subject) ?? 0, l.overage_cents));
	const monthly = [...maxBySubject.values()].reduce((s, v) => s + v, 0);
	return {
		monthly_cents: monthly,
		annual_cents: monthly * 12,
		lines: lines.map(({ subject: _subject, ...l }) => l),
		assumptions: [
			"Assumes this month's flagged overages repeat every month.",
			'Sums active budget-overage and spend-spike Concerns only, deduplicated per category — dismissing one there removes it here.'
		]
	};
}

const setting = (db: Database, key: string) =>
	db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as string | undefined;

export function assumedReturnPct(db: Database): number {
	const n = Number(setting(db, 'assumed_return_pct'));
	return Number.isFinite(n) && n > -100 ? n : 5;
}

/**
 * One plan per 529 Account. Some institutions send no investments transactions for these,
 * so the detected contribution rate comes from one-sided saved cash legs
 * (p1-12 flow: is_saved=1, no peer), which cannot name their destination —
 * the total is split evenly across 529 Accounts; the override knob wins.
 */
export function plans529(db: Database, today: string): (Plan529 | NeedsSetup529)[] {
	const accounts = db
		.prepare(
			"SELECT id, name, current_balance_cents FROM accounts WHERE subtype = '529' ORDER BY id"
		)
		.all() as { id: number; name: string; current_balance_cents: number | null }[];
	if (accounts.length === 0) return [];

	const month = today.slice(0, 7);
	const detectedTotal = db
		.prepare(
			`SELECT COALESCE(SUM(-amount_cents), 0) / 3 FROM transactions
			 WHERE is_saved = 1 AND transfer_peer_id IS NULL AND amount_cents < 0
			   AND date >= ? AND date < ?`
		)
		.pluck()
		.get(`${shiftMonth(month, -3)}-01`, `${month}-01`) as number;
	const perAccount = Math.round(detectedTotal / accounts.length);
	const returnPct = assumedReturnPct(db);
	const todayYear = Number(today.slice(0, 4));

	return accounts.map((a) => {
		// Age is derived from a stored birth year so the college year stays fixed
		// to the child across calendar years (#14) — never re-entered annually.
		const birthYear = Number(setting(db, `529_${a.id}_birth_year`));
		const age = todayYear - birthYear;
		const targetDollars = Number(setting(db, `529_${a.id}_target_dollars`));
		if (!Number.isFinite(birthYear) || !(targetDollars > 0))
			return { needsSetup: true, account_id: a.id, account_name: a.name };
		const overrideDollars = Number(setting(db, `529_${a.id}_override_monthly_dollars`));
		const hasOverride = Number.isFinite(overrideDollars) && overrideDollars >= 0;
		return project529(
			{
				account_id: a.id,
				account_name: a.name,
				beneficiary: setting(db, `529_${a.id}_name`) ?? a.name,
				age,
				target_cents: Math.round(targetDollars * 100),
				balance_cents: a.current_balance_cents ?? 0,
				monthly_contribution_cents: hasOverride ? Math.round(overrideDollars * 100) : perAccount,
				contribution_source: hasOverride ? 'override' : perAccount > 0 ? 'detected' : 'none'
			},
			{ returnPct, todayYear }
		);
	});
}
