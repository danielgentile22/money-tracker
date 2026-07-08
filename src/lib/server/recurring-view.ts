import type { Cadence } from './recurring';

// Read-time view over recurring_series rows: derived state (upcoming/late/ended),
// next expected date, monthlyized amounts, and the committed-monthly headline.
// Nothing here is stored — state is arithmetic over last_seen vs today (PRD:
// .scratch/recurring-page).

export type SeriesRow = {
	id: number;
	merchant: string;
	cadence: Cadence;
	typical_amount_cents: number;
	last_amount_cents: number;
	first_seen: string;
	last_seen: string;
};

export type SeriesState = 'upcoming' | 'late' | 'ended';

export type SeriesView = SeriesRow & {
	state: SeriesState;
	next_expected: string;
	monthlyized_cents: number;
};

export type RecurringView = {
	committed_monthly_cents: number; // upcoming + late, monthlyized on latest price
	active: SeriesView[]; // sorted by next_expected asc — late naturally floats up
	ended: SeriesView[];
};

const GAP_DAYS: Record<Cadence, number> = { weekly: 7, monthly: 30, annual: 365 };
const MONTHLY_FACTOR: Record<Cadence, number> = { weekly: 52 / 12, monthly: 1, annual: 1 / 12 };

const DAY = 86_400_000;
const addDays = (date: string, days: number) =>
	new Date(Date.parse(date) + days * DAY).toISOString().slice(0, 10);

export function buildRecurringView(rows: SeriesRow[], today: string, dayTolerance = 3): RecurringView {
	const active: SeriesView[] = [];
	const ended: SeriesView[] = [];
	for (const row of rows) {
		const gap = GAP_DAYS[row.cadence];
		const next_expected = addDays(row.last_seen, gap);
		const state: SeriesState =
			today > addDays(row.last_seen, 2 * gap + dayTolerance)
				? 'ended'
				: today > addDays(next_expected, dayTolerance)
					? 'late'
					: 'upcoming';
		(state === 'ended' ? ended : active).push({
			...row,
			state,
			next_expected,
			monthlyized_cents: Math.round(row.last_amount_cents * MONTHLY_FACTOR[row.cadence])
		});
	}
	active.sort((a, b) => a.next_expected.localeCompare(b.next_expected));
	return {
		committed_monthly_cents: active.reduce((sum, s) => sum + s.monthlyized_cents, 0),
		active,
		ended
	};
}
