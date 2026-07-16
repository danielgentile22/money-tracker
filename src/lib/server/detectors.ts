import type { Database } from 'better-sqlite3';
import { monthSummary, spendingByCategory, fullMonthsOfHistory } from './analytics';
import { budgetStatus } from './budgets';
import { localToday } from './balances';
import { upsertConcerns, expireConcerns, identityOf, type ConcernCandidate } from './concerns';
import { fmtUSD } from '../money';

// Detector registry (PRD Phase 2): pure-ish functions sharing one signature —
// ledger aggregates + knob values in, Concern candidates out. Knob defaults
// live here in code; the settings table stores only overrides
// (detector_<detector>_<knob>) and disable flags (detector_<detector>_enabled).

export type KnobDef = {
	key: string;
	label: string;
	default: number;
	unit: '$' | 'days' | '×' | '%';
};

export type DetectorDef = {
	key: string;
	label: string;
	knobs: KnobDef[];
	/** Trailing history this Detector needs; below it, it stays silent (warming up). */
	minFullMonths?: number;
	run(db: Database, knobs: Record<string, number>, today: string): ConcernCandidate[];
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

const monthLabel = (month: string) =>
	new Date(`${month}-15T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

const pct = (r: number) => `${(r * 100).toFixed(1)}%`;

function shiftMonth(month: string, delta: number): string {
	const [y, m] = month.split('-').map(Number);
	const n = y * 12 + (m - 1) + delta;
	return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`;
}

const shiftDays = (date: string, delta: number) =>
	new Date(Date.parse(date + 'T00:00:00Z') + delta * 86_400_000).toISOString().slice(0, 10);

// Per-transaction detectors look back a trailing window rather than the current
// calendar month, so a month-end charge synced after rollover (Plaid's 1–3 day
// posting lag) still gets evaluated instead of falling through the crack between
// the month it's dated in and the month it arrives in (#13). Concern identities
// key on the transaction, so a row surfaces for ~35 days then ages out.
const LOOKBACK_DAYS = 35;

type TxnRow = {
	id: number;
	date: string;
	merchant: string | null;
	name: string;
	amount_cents: number;
	category_name: string | null;
};

const feesInterest: DetectorDef = {
	key: 'fees-interest',
	label: 'Fees & interest',
	knobs: [],
	run(db, _knobs, today) {
		const rows = db
			.prepare(
				`SELECT t.id, t.date, t.merchant, t.name, t.amount_cents, c.name AS category_name
				 FROM transactions t JOIN categories c ON c.id = t.category_id
				 WHERE c.name IN ('Fees', 'Interest') AND t.amount_cents < 0
				   AND t.is_transfer = 0 AND t.is_investment_activity = 0
				   AND t.date >= ? AND t.date <= ?`
			)
			.all(shiftDays(today, -LOOKBACK_DAYS), today) as TxnRow[];
		return rows.map((t) => {
			const abs = -t.amount_cents;
			return {
				detector: this.key,
				subject: `txn:${t.id}`,
				period: t.date,
				severity: clamp(10 + Math.round((abs * 90) / 10_000), 10, 100), // $100 ⇒ max
				title: `${fmtUSD(abs)} ${t.category_name!.toLowerCase()} — ${t.merchant ?? t.name} · ${t.date}`,
				figures: { amount_cents: abs, merchant: t.merchant ?? t.name, date: t.date },
				txn_ids: [t.id]
			};
		});
	}
};

const largeOneOff: DetectorDef = {
	key: 'large-one-off',
	label: 'Large one-off',
	knobs: [{ key: 'floor', label: 'Minimum amount', default: 500, unit: '$' }],
	run(db, knobs, today) {
		const floorCents = Math.round(knobs.floor * 100);
		const rows = db
			.prepare(
				`SELECT t.id, t.date, t.merchant, t.name, t.amount_cents, NULL AS category_name
				 FROM transactions t
				 WHERE t.amount_cents <= ? AND t.is_transfer = 0 AND t.is_investment_activity = 0
				   AND t.recurring_series_id IS NULL AND t.date >= ? AND t.date <= ?`
			)
			.all(-floorCents, shiftDays(today, -LOOKBACK_DAYS), today) as TxnRow[];
		return rows.map((t) => {
			const abs = -t.amount_cents;
			return {
				detector: this.key,
				subject: `txn:${t.id}`,
				period: t.date,
				severity: clamp(30 + Math.round(((abs - floorCents) * 70) / (3 * floorCents)), 30, 100),
				title: `Large one-off: ${fmtUSD(abs)} — ${t.merchant ?? t.name} · ${t.date}`,
				figures: { amount_cents: abs, merchant: t.merchant ?? t.name, date: t.date },
				txn_ids: [t.id]
			};
		});
	}
};

const negativeCashFlow: DetectorDef = {
	key: 'negative-cash-flow',
	label: 'Negative cash flow',
	knobs: [],
	run(db, _knobs, today) {
		const month = today.slice(0, 7);
		const s = monthSummary(db, month);
		if (s.txn_count === 0 || s.cash_flow_cents >= 0) return [];
		const deficit = -s.cash_flow_cents;
		return [
			{
				detector: this.key,
				subject: 'month',
				period: month,
				severity: clamp(15 + Math.round((deficit / Math.max(s.income_cents, 1)) * 85), 15, 100),
				title: `Spending exceeded income by ${fmtUSD(deficit)} in ${monthLabel(month)}`,
				figures: {
					deficit_cents: deficit,
					income_cents: s.income_cents,
					expenses_cents: s.expenses_cents
				},
				txn_ids: []
			}
		];
	}
};

const spendSpike: DetectorDef = {
	key: 'spend-spike',
	label: 'Spend spike',
	minFullMonths: 3,
	knobs: [
		{ key: 'multiplier', label: 'Above trailing average', default: 1.5, unit: '×' },
		{ key: 'floor', label: 'Minimum month-to-date', default: 50, unit: '$' }
	],
	run(db, knobs, today) {
		const month = today.slice(0, 7);
		const floorCents = Math.round(knobs.floor * 100);
		// trailing 3 full months, averaged per Category (missing months count as zero)
		const avgRows = db
			.prepare(
				`SELECT category_id, SUM(-amount_cents) / 3.0 AS avg_cents
				 FROM transactions
				 WHERE is_investment_activity = 0 AND is_transfer = 0 AND amount_cents < 0
				   AND date >= ? AND date < ?
				 GROUP BY category_id`
			)
			.all(`${shiftMonth(month, -3)}-01`, `${month}-01`) as {
			category_id: number | null;
			avg_cents: number;
		}[];
		const avgBy = new Map(avgRows.map((r) => [r.category_id, r.avg_cents]));
		const txnIds = db.prepare(
			`SELECT id FROM transactions
			 WHERE is_investment_activity = 0 AND is_transfer = 0 AND amount_cents < 0
			   AND substr(date, 1, 7) = ? AND category_id IS ?`
		);
		const out: ConcernCandidate[] = [];
		for (const c of spendingByCategory(db, month)) {
			const avg = avgBy.get(c.category_id) ?? 0;
			if (avg <= 0) continue; // no baseline — a brand-new Category can't "spike"
			const ratio = c.spent_cents / avg;
			if (c.spent_cents < floorCents || ratio < knobs.multiplier) continue;
			out.push({
				detector: this.key,
				subject: `category:${c.category_id ?? 'uncategorized'}`,
				period: month,
				severity: clamp(30 + Math.round((ratio - knobs.multiplier) * 40), 30, 100),
				title: `${c.name ?? 'Uncategorized'} at ${fmtUSD(c.spent_cents)} this month — ${ratio.toFixed(1)}× its ${fmtUSD(Math.round(avg))} trailing average`,
				figures: { mtd_cents: c.spent_cents, avg_cents: Math.round(avg), ratio: +ratio.toFixed(2) },
				txn_ids: (txnIds.all(month, c.category_id) as { id: number }[]).map((r) => r.id)
			});
		}
		return out;
	}
};

const savingsRateDrop: DetectorDef = {
	key: 'savings-rate-drop',
	label: 'Savings-rate drop',
	minFullMonths: 3,
	knobs: [{ key: 'drop', label: 'Relative drop', default: 25, unit: '%' }],
	run(db, knobs, today) {
		const month = today.slice(0, 7);
		const rates = [-3, -2, -1]
			.map((d) => monthSummary(db, shiftMonth(month, d)).savings_rate)
			.filter((r): r is number => r != null);
		if (rates.length === 0) return [];
		const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
		const cur = monthSummary(db, month).savings_rate;
		if (avg <= 0 || cur == null || cur >= avg * (1 - knobs.drop / 100)) return [];
		const relDrop = (avg - cur) / avg;
		return [
			{
				detector: this.key,
				subject: 'savings-rate',
				period: month,
				severity: clamp(15 + Math.round(relDrop * 85), 15, 100),
				title: `Savings rate ${pct(cur)} this month — down from a ${pct(avg)} trailing average`,
				figures: { current_pct: +(cur * 100).toFixed(1), avg_pct: +(avg * 100).toFixed(1) },
				txn_ids: []
			}
		];
	}
};

const lowBalanceRunway: DetectorDef = {
	key: 'low-balance-runway',
	label: 'Low-balance runway',
	minFullMonths: 1,
	knobs: [{ key: 'horizon', label: 'Warning horizon', default: 30, unit: 'days' }],
	run(db, knobs, today) {
		const accounts = db
			.prepare(
				`SELECT id, name, current_balance_cents FROM accounts
				 WHERE type = 'depository' AND subtype = 'checking' AND current_balance_cents IS NOT NULL`
			)
			.all() as { id: number; name: string; current_balance_cents: number }[];
		const net = db.prepare(
			`SELECT COALESCE(SUM(amount_cents), 0) FROM transactions
			 WHERE account_id = ? AND is_investment_activity = 0 AND date >= ? AND date <= ?`
		);
		const out: ConcernCandidate[] = [];
		for (const a of accounts) {
			// net of everything incl. Transfers — runway is about actual cash leaving
			const flow = net.pluck().get(a.id, shiftDays(today, -30), today) as number;
			if (flow >= 0) continue;
			const burnPerDay = -flow / 30;
			const daysLeft = Math.floor(a.current_balance_cents / burnPerDay);
			if (daysLeft > knobs.horizon) continue;
			out.push({
				detector: this.key,
				subject: `account:${a.id}`,
				period: 'ongoing',
				severity: clamp(Math.round(100 - (daysLeft / knobs.horizon) * 70), 30, 100),
				title: `${a.name} on pace to run dry in ~${daysLeft} days (${fmtUSD(a.current_balance_cents)} left, ${fmtUSD(Math.round(burnPerDay))}/day net burn)`,
				figures: {
					balance_cents: a.current_balance_cents,
					burn_cents_per_day: Math.round(burnPerDay),
					days_left: daysLeft
				},
				txn_ids: []
			});
		}
		return out;
	}
};

type SeriesRow = {
	id: number;
	merchant: string;
	cadence: string;
	typical_amount_cents: number;
	last_amount_cents: number;
	first_seen: string;
	last_seen: string;
};

const newRecurring: DetectorDef = {
	key: 'new-recurring',
	label: 'New recurring charge',
	knobs: [],
	run(db, _knobs, today) {
		const month = today.slice(0, 7);
		// "new" = the occurrence that crystallized the series (its 3rd, the
		// recurring module's minimum) landed this month. first_seen alone can't
		// work for monthly cadence — three bills span two months by definition.
		const rows = db
			.prepare(
				`SELECT rs.*, (SELECT date FROM transactions t WHERE t.recurring_series_id = rs.id
				               ORDER BY t.date LIMIT 1 OFFSET 2) AS third_seen
				 FROM recurring_series rs`
			)
			.all() as (SeriesRow & { third_seen: string | null })[];
		return rows
			.filter((s) => s.third_seen != null && s.third_seen.slice(0, 7) === month)
			.map((s) => ({
				detector: this.key,
				subject: `merchant:${s.merchant}`,
				period: month,
				severity: clamp(20 + Math.round((s.typical_amount_cents * 60) / 10_000), 20, 90),
				title: `New ${s.cadence} charge: ${s.merchant} at ${fmtUSD(s.typical_amount_cents)} (recurring since ${s.first_seen})`,
				figures: { typical_cents: s.typical_amount_cents, cadence: s.cadence, first_seen: s.first_seen },
				txn_ids: (
					db.prepare('SELECT id FROM transactions WHERE recurring_series_id = ? ORDER BY date').all(s.id) as { id: number }[]
				).map((r) => r.id)
			}));
	}
};

const subscriptionCreep: DetectorDef = {
	key: 'subscription-creep',
	label: 'Subscription creep',
	knobs: [{ key: 'tolerance', label: 'Price-rise tolerance', default: 20, unit: '%' }],
	run(db, knobs) {
		const rows = db.prepare('SELECT * FROM recurring_series').all() as SeriesRow[];
		return rows
			.filter((s) => s.last_amount_cents > s.typical_amount_cents * (1 + knobs.tolerance / 100))
			.map((s) => {
				const pctUp = (s.last_amount_cents - s.typical_amount_cents) / s.typical_amount_cents;
				return {
					detector: this.key,
					subject: `merchant:${s.merchant}`,
					period: 'ongoing', // clears when the typical amount absorbs the new price
					severity: clamp(Math.round(pctUp * 100), 25, 95),
					title: `${s.merchant} crept ${fmtUSD(s.typical_amount_cents)} → ${fmtUSD(s.last_amount_cents)} per ${s.cadence === 'annual' ? 'year' : s.cadence === 'weekly' ? 'week' : 'month'} (+${Math.round(pctUp * 100)}%)`,
					figures: { old_cents: s.typical_amount_cents, new_cents: s.last_amount_cents, pct_up: Math.round(pctUp * 100) },
					txn_ids: (
						db.prepare('SELECT id FROM transactions WHERE recurring_series_id = ? ORDER BY date DESC LIMIT 2').all(s.id) as { id: number }[]
					).map((r) => r.id)
				};
			});
	}
};

const duplicateCharge: DetectorDef = {
	key: 'duplicate-charge',
	label: 'Duplicate charge',
	knobs: [{ key: 'window', label: 'Days apart', default: 3, unit: 'days' }],
	run(db, knobs, today) {
		const rows = db
			.prepare(
				`SELECT id, merchant, date, amount_cents FROM transactions
				 WHERE amount_cents < 0 AND merchant IS NOT NULL AND is_transfer = 0
				   AND is_investment_activity = 0 AND recurring_series_id IS NULL
				   AND date >= ? AND date <= ?
				 ORDER BY merchant COLLATE NOCASE, amount_cents, date`
			)
			.all(shiftDays(today, -(LOOKBACK_DAYS + knobs.window)), today) as {
			id: number;
			merchant: string;
			date: string;
			amount_cents: number;
		}[];
		const out: ConcernCandidate[] = [];
		for (let i = 1; i < rows.length; i++) {
			const a = rows[i - 1];
			const b = rows[i];
			if (a.merchant.toLowerCase() !== b.merchant.toLowerCase() || a.amount_cents !== b.amount_cents) continue;
			const gap = Math.round((Date.parse(b.date) - Date.parse(a.date)) / 86_400_000);
			// report a pair whose second charge fell inside the trailing window, so
			// a month-end duplicate synced after rollover still fires (#13)
			if (gap > knobs.window || b.date < shiftDays(today, -LOOKBACK_DAYS)) continue;
			const abs = -a.amount_cents;
			out.push({
				detector: this.key,
				subject: `merchant:${a.merchant.toLowerCase()}:${abs}:${a.date}`,
				period: b.date,
				severity: clamp(20 + Math.round((abs * 60) / 20_000), 20, 90),
				title: `Possible duplicate: 2 × ${fmtUSD(abs)} at ${a.merchant} within ${gap} day${gap === 1 ? '' : 's'}`,
				figures: { amount_cents: abs, merchant: a.merchant, first_date: a.date, second_date: b.date },
				txn_ids: [a.id, b.id]
			});
		}
		return out;
	}
};

const budgetOverage: DetectorDef = {
	key: 'budget-overage',
	label: 'Budget overage',
	knobs: [],
	run(db, _knobs, today) {
		const month = today.slice(0, 7);
		const txnIds = db.prepare(
			`SELECT id FROM transactions
			 WHERE category_id = ? AND amount_cents < 0 AND is_transfer = 0
			   AND is_investment_activity = 0 AND substr(date, 1, 7) = ?`
		);
		return budgetStatus(db, month)
			.filter((b) => b.actual_cents > b.target_cents)
			.map((b) => {
				const over = b.actual_cents - b.target_cents;
				return {
					detector: this.key,
					subject: `category:${b.category_id}`,
					period: month,
					severity: clamp(30 + Math.round((over / b.target_cents) * 100), 30, 100),
					title: `${b.name} at ${fmtUSD(b.actual_cents)} of its ${fmtUSD(b.target_cents)} budget (+${fmtUSD(over)}) in ${monthLabel(month)}`,
					figures: { target_cents: b.target_cents, actual_cents: b.actual_cents, overage_cents: over },
					txn_ids: (txnIds.all(b.category_id, month) as { id: number }[]).map((r) => r.id)
				};
			});
	}
};

export const DETECTORS: DetectorDef[] = [
	feesInterest,
	largeOneOff,
	negativeCashFlow,
	spendSpike,
	savingsRateDrop,
	lowBalanceRunway,
	newRecurring,
	subscriptionCreep,
	duplicateCharge,
	budgetOverage
];

export function knobValues(db: Database, det: DetectorDef): Record<string, number> {
	const get = db.prepare('SELECT value FROM settings WHERE key = ?').pluck();
	const out: Record<string, number> = {};
	for (const k of det.knobs) {
		const override = get.get(`detector_${det.key}_${k.key}`) as string | undefined;
		const n = override == null ? NaN : Number(override);
		out[k.key] = Number.isFinite(n) ? n : k.default;
	}
	return out;
}

export function detectorEnabled(db: Database, key: string): boolean {
	return (
		db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(`detector_${key}_enabled`) !==
		'0'
	);
}

/** Detectors still below their history minimum — the UI must not imply "all clear". */
export function warmingUp(db: Database, today = localToday()): { label: string; needMonths: number }[] {
	const months = fullMonthsOfHistory(db, today);
	return DETECTORS.filter((d) => (d.minFullMonths ?? 0) > months).map((d) => ({
		label: d.label,
		needMonths: d.minFullMonths!
	}));
}

/** Post-sync step: run every enabled Detector, upsert its Concerns, expire the rest. */
export function runDetectors(db: Database, today = localToday()): void {
	const months = fullMonthsOfHistory(db, today);
	const fired = new Set<string>();
	const candidates: ConcernCandidate[] = [];
	for (const det of DETECTORS) {
		if (!detectorEnabled(db, det.key) || (det.minFullMonths ?? 0) > months) continue;
		for (const c of det.run(db, knobValues(db, det), today)) {
			candidates.push(c);
			fired.add(identityOf(c));
		}
	}
	upsertConcerns(db, candidates);
	expireConcerns(db, fired);
}
