import type { Database } from 'better-sqlite3';

// Recurring-series detection over normalized Merchants (PRD Phase 2): ≥3
// occurrences at a stable cadence and stable amount. Feeds three Detectors
// and the run-rate Projection; membership is persisted so consumers query.

export type RecurringTxn = { id: number; merchant: string; date: string; amount_cents: number };

export type Cadence = 'weekly' | 'monthly' | 'annual';

export type Series = {
	merchant: string;
	cadence: Cadence;
	typical_amount_cents: number; // positive magnitude, median of occurrences
	last_amount_cents: number; // magnitude of most recent occurrence
	first_seen: string;
	last_seen: string;
	member_ids: number[];
};

export type RecurringKnobs = {
	amountTolerance: number; // fraction of typical amount, default 0.2
	dayTolerance: number; // days of jitter around the series' own median gap, default 3
};

export const RECURRING_DEFAULTS: RecurringKnobs = { amountTolerance: 0.2, dayTolerance: 3 };

const DAY = 86_400_000;
const gapDays = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

// Natural gap band per cadence (monthly spans month lengths, annual leap years);
// dayTolerance stretches the band to absorb billing jitter.
const BANDS: Record<Cadence, [number, number]> = {
	weekly: [7, 7],
	monthly: [28, 31],
	annual: [365, 366]
};

/** Median inter-occurrence gap → candidate cadence, or null if nowhere close. */
function cadenceFor(medianGap: number): Cadence | null {
	if (medianGap >= 6 && medianGap <= 8) return 'weekly';
	if (medianGap >= 26 && medianGap <= 33) return 'monthly';
	if (medianGap >= 350 && medianGap <= 380) return 'annual';
	return null;
}

export function detectRecurring(txns: RecurringTxn[], knobs: RecurringKnobs): Series[] {
	// ponytail: one candidate series per merchant, charges only. A real
	// subscription hiding inside a noisy merchant (Amazon) won't surface;
	// amount-clustering within merchant is the upgrade path if that bites.
	const byMerchant = new Map<string, RecurringTxn[]>();
	for (const t of txns) {
		if (t.amount_cents >= 0) continue;
		const key = t.merchant.toLowerCase();
		byMerchant.set(key, [...(byMerchant.get(key) ?? []), t]);
	}

	const series: Series[] = [];
	for (const [, occ] of byMerchant) {
		if (occ.length < 3) continue;
		occ.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));

		const gaps = occ.slice(1).map((t, i) => gapDays(occ[i].date, t.date));
		const cadence = cadenceFor(median(gaps));
		if (cadence === null) continue;
		const [lo, hi] = BANDS[cadence];
		if (gaps.some((g) => g < lo - knobs.dayTolerance || g > hi + knobs.dayTolerance)) continue; // erratic

		const amounts = occ.map((t) => -t.amount_cents);
		const typical = median(amounts);
		// all but the latest must hold amount tolerance — the latest may drift,
		// that drift IS the subscription-creep signal (P2.5)
		const stable = amounts
			.slice(0, -1)
			.every((a) => Math.abs(a - typical) <= typical * knobs.amountTolerance);
		if (!stable) continue;

		series.push({
			merchant: occ[0].merchant.toLowerCase(),
			cadence,
			typical_amount_cents: typical,
			last_amount_cents: amounts[amounts.length - 1],
			first_seen: occ[0].date,
			last_seen: occ[occ.length - 1].date,
			member_ids: occ.map((t) => t.id)
		});
	}
	return series;
}

export function recurringKnobs(db: Database): RecurringKnobs {
	const get = (key: string) =>
		db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as string | undefined;
	return {
		amountTolerance: Number(get('recurring_amount_tolerance') ?? RECURRING_DEFAULTS.amountTolerance),
		dayTolerance: Number(get('recurring_day_tolerance') ?? RECURRING_DEFAULTS.dayTolerance)
	};
}

/** Post-sync step: wholesale rebuild of series + membership (idempotent). */
export function runRecurringDetection(db: Database): void {
	const txns = db
		.prepare(
			`SELECT id, merchant, date, amount_cents FROM transactions
			 WHERE merchant IS NOT NULL AND is_transfer = 0 AND is_investment_activity = 0
				   AND lower(merchant) NOT IN (SELECT merchant FROM muted_merchants)`
		)
		.all() as RecurringTxn[];
	const series = detectRecurring(txns, recurringKnobs(db));

	db.transaction(() => {
		db.prepare('UPDATE transactions SET recurring_series_id = NULL WHERE recurring_series_id IS NOT NULL').run();
		db.prepare('DELETE FROM recurring_series').run();
		const ins = db.prepare(
			`INSERT INTO recurring_series (merchant, cadence, typical_amount_cents, last_amount_cents, first_seen, last_seen)
			 VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
		);
		const mark = db.prepare('UPDATE transactions SET recurring_series_id = ? WHERE id = ?');
		for (const s of series) {
			const id = ins.pluck().get(s.merchant, s.cadence, s.typical_amount_cents, s.last_amount_cents, s.first_seen, s.last_seen) as number;
			for (const txnId of s.member_ids) mark.run(id, txnId);
		}
	})();
}
