import { db } from '$lib/server/db';
import { runRateProjection, plans529, counterfactual } from '$lib/server/projections';
import { monthSummary, monthRange, shiftMonth } from '$lib/server/analytics';
import { localToday } from '$lib/server/balances';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	const today = localToday();
	const month = today.slice(0, 7);
	const runRate = runRateProjection(db, today);

	// chart series: trailing actual nets (solid) + the projection (dashed)
	const actual = monthRange(shiftMonth(month, -5), shiftMonth(month, -1)).map((m) => ({
		date: `${m}-15`,
		value_cents: monthSummary(db, m).cash_flow_cents,
		estimated: 0
	}));
	const projected = runRate.insufficient
		? []
		: runRate.months.map((p) => ({ date: `${p.month}-15`, value_cents: p.projected_cents, estimated: 1 }));

	const plans = plans529(db, today).map((p) =>
		'needsSetup' in p
			? p
			: {
					...p,
					// chart: today's balance real, every later year projected (dashed)
					series: p.path.map((pt) => ({
						date: `${pt.year}-06-15`,
						value_cents: pt.balance_cents,
						estimated: pt.year === Number(today.slice(0, 4)) ? 0 : 1
					}))
				}
	);

	return { runRate, series: [...actual, ...projected], plans, counterfactual: counterfactual(db) };
};
