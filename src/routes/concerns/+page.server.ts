import { db } from '$lib/server/db';
import { formId } from '$lib/server/form-id';
import { activeConcerns, dismissConcern, bucketFor, type ConcernRow } from '$lib/server/concerns';
import { warmingUp } from '$lib/server/detectors';
import { fullMonthsOfHistory, monthSummary, categoryTrend, monthRange, shiftMonth } from '$lib/server/analytics';
import { localToday } from '$lib/server/balances';
import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

/** The Concern's underlying trend, per Detector kind (PRD: feed + sparklines). */
function sparkFor(c: ConcernRow, today: string): number[] {
	const month = today.slice(0, 7);
	const last6 = monthRange(shiftMonth(month, -5), month);
	switch (c.detector) {
		case 'spend-spike': {
			const id = Number(c.subject.split(':')[1]);
			if (!Number.isFinite(id)) return [];
			return categoryTrend(db, id, last6[0], month).map((p) => p.spent_cents);
		}
		case 'negative-cash-flow':
			return last6.map((m) => monthSummary(db, m).cash_flow_cents);
		case 'savings-rate-drop':
			return last6.map((m) => monthSummary(db, m).savings_rate ?? 0);
		case 'low-balance-runway': {
			const id = Number(c.subject.split(':')[1]);
			return (
				db
					.prepare('SELECT balance_cents FROM snapshots WHERE account_id = ? ORDER BY date DESC LIMIT 30')
					.all(id) as { balance_cents: number }[]
			)
				.map((r) => r.balance_cents)
				.reverse();
		}
		default: {
			// merchant-anchored Detectors: recent charge amounts at that merchant
			const merchant = (JSON.parse(c.figures) as { merchant?: string }).merchant;
			if (!merchant) return [];
			return (
				db
					.prepare(
						`SELECT -amount_cents AS abs_cents FROM transactions
						 WHERE merchant = ? COLLATE NOCASE AND amount_cents < 0 AND is_investment_activity = 0
						 ORDER BY date DESC LIMIT 8`
					)
					.all(merchant) as { abs_cents: number }[]
			)
				.map((r) => r.abs_cents)
				.reverse();
		}
	}
}

/** Click-through: a txn-backed Concern focuses the ledger; a month-scoped one filters it. */
function ledgerLink(period: string, txnIds: number[]): string {
	if (txnIds.length === 1) return `/transactions?focus=${txnIds[0]}`;
	if (period.length === 7) return `/transactions?from=${period}-01&to=${period}-31`;
	return '/transactions';
}

export const load: PageServerLoad = () => ({
	warming: warmingUp(db),
	fullMonths: fullMonthsOfHistory(db, localToday()),
	concerns: activeConcerns(db).map((c) => {
		const txnIds = JSON.parse(c.txn_ids) as number[];
		return {
			id: c.id,
			detector: c.detector,
			title: c.title,
			severity: c.severity,
			bucket: bucketFor(c.severity),
			updated_at: c.updated_at,
			narration: c.narration,
			link: ledgerLink(c.period, txnIds),
			spark: sparkFor(c, localToday())
		};
	})
});

export const actions: Actions = {
	dismiss: async ({ request }) => {
		const form = await request.formData();
		const id = formId(form);
		if (id == null || !dismissConcern(db, id)) return fail(400, { message: 'no such Concern' });
		return { ok: true };
	}
};
