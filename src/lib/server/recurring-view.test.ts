import { test, expect } from 'vitest';
import { buildRecurringView, type SeriesRow } from './recurring-view';

let seq = 0;
const series = (over: Partial<SeriesRow>): SeriesRow => ({
	id: ++seq,
	merchant: 'netflix',
	cadence: 'monthly',
	typical_amount_cents: 1549,
	last_amount_cents: 1549,
	first_seen: '2026-03-05',
	last_seen: '2026-06-05',
	...over
});

test('a monthly series seen recently is upcoming, one gap after last_seen', () => {
	const view = buildRecurringView([series({})], '2026-06-20');
	expect(view.active).toHaveLength(1);
	const s = view.active[0];
	expect(s.state).toBe('upcoming');
	expect(s.next_expected).toBe('2026-07-05'); // last_seen + 30 days
	expect(s.monthlyized_cents).toBe(1549);
	expect(view.committed_monthly_cents).toBe(1549);
	expect(view.ended).toEqual([]);
});

test('past expected date beyond tolerance is late — still active, still committed', () => {
	// next_expected 2026-07-05, tolerance 3: the 8th is still upcoming, the 9th is late
	const grace = buildRecurringView([series({})], '2026-07-08');
	expect(grace.active[0].state).toBe('upcoming');

	const late = buildRecurringView([series({})], '2026-07-09');
	expect(late.active[0].state).toBe('late');
	expect(late.committed_monthly_cents).toBe(1549);
});

test('two missed cycles means ended: out of the total, into the ended list', () => {
	// last_seen 2026-06-05 + 2×30 days = 2026-08-04, +3 tolerance → ended from the 8th
	const stillLate = buildRecurringView([series({})], '2026-08-07');
	expect(stillLate.active[0].state).toBe('late');

	const view = buildRecurringView([series({})], '2026-08-08');
	expect(view.active).toEqual([]);
	expect(view.ended).toHaveLength(1);
	expect(view.ended[0].state).toBe('ended');
	expect(view.committed_monthly_cents).toBe(0);
});

test('headline monthlyizes each cadence on its latest price and sums active series', () => {
	const view = buildRecurringView(
		[
			series({ cadence: 'weekly', last_seen: '2026-06-18', last_amount_cents: 1000 }),
			series({ cadence: 'monthly', last_seen: '2026-06-05', typical_amount_cents: 1399, last_amount_cents: 1549 }),
			series({ cadence: 'annual', last_seen: '2025-11-20', last_amount_cents: 12000 })
		],
		'2026-06-20'
	);
	const byCadence = Object.fromEntries(view.active.map((s) => [s.cadence, s.monthlyized_cents]));
	expect(byCadence).toEqual({ weekly: 4333, monthly: 1549, annual: 1000 }); // 1000×52/12, latest price, 12000/12
	expect(view.committed_monthly_cents).toBe(4333 + 1549 + 1000);
});

test('active list is sorted by next expected date, soonest first', () => {
	const view = buildRecurringView(
		[
			series({ merchant: 'annual-nov', cadence: 'annual', last_seen: '2025-11-20' }),
			series({ merchant: 'monthly-jul', cadence: 'monthly', last_seen: '2026-06-05' }),
			series({ merchant: 'weekly-jun', cadence: 'weekly', last_seen: '2026-06-18' }),
			series({ merchant: 'overdue-may', cadence: 'monthly', last_seen: '2026-05-10' }) // late — earliest of all
		],
		'2026-06-20'
	);
	expect(view.active.map((s) => s.merchant)).toEqual([
		'overdue-may', // next_expected 2026-06-09, late
		'weekly-jun', // 2026-06-25
		'monthly-jul', // 2026-07-05
		'annual-nov' // 2026-11-20
	]);
});
