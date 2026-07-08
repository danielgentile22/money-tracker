import { db } from '$lib/server/db';
import { fullMonthsOfHistory, MIN_FULL_MONTHS } from '$lib/server/analytics';
import { localToday } from '$lib/server/balances';
import { warmingUp } from '$lib/server/detectors';
import { generateInsight } from '$lib/server/insights';
import { anthropicReady, realLlm } from '$lib/server/llm';
import { readLayout, buildSnapshot } from '$lib/server/dashboard';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = () => {
	const today = localToday();
	const layout = readLayout(db);

	return {
		layout,
		snapshot: buildSnapshot(db, layout, today),
		// honesty banners stay fixed chrome above the grid — never hideable
		chrome: {
			warmingCount: warmingUp(db).length,
			unreviewedTransfers: db
				.prepare(
					"SELECT COUNT(*) FROM review_items WHERE kind = 'transfer-ambiguity' AND status = 'open'"
				)
				.pluck()
				.get() as number,
			fullMonths: fullMonthsOfHistory(db, today),
			minFullMonths: MIN_FULL_MONTHS
		},
		anthropicReady: anthropicReady()
	};
};

export const actions: Actions = {
	// story 25 (p3-05): on-demand narration for the current month; regenerating replaces
	explain: async () => {
		const month = localToday().slice(0, 7);
		const insight = await generateInsight(db, realLlm, 'explain', month);
		return { ok: true, unavailable: insight === null };
	}
	// layout editing moved to Settings → Layout (Session 6)
};
