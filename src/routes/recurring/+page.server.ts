import { db } from '$lib/server/db';
import { localToday } from '$lib/server/balances';
import { runRecurringDetection, recurringKnobs } from '$lib/server/recurring';
import { buildRecurringView, type SeriesRow } from '$lib/server/recurring-view';
import { fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = () => {
	const rows = db
		.prepare(
			`SELECT id, merchant, cadence, typical_amount_cents, last_amount_cents, first_seen, last_seen
			 FROM recurring_series`
		)
		.all() as SeriesRow[];
	const today = localToday();
	return {
		view: buildRecurringView(rows, today, recurringKnobs(db).dayTolerance),
		muted: db
			.prepare('SELECT merchant, muted_at FROM muted_merchants ORDER BY merchant')
			.all() as { merchant: string; muted_at: string }[]
	};
};

export const actions: Actions = {
	mute: async ({ request }) => {
		const merchant = ((await request.formData()).get('merchant') as string)?.trim().toLowerCase();
		if (!merchant) return fail(400, { message: 'Merchant required' });
		db.prepare('INSERT OR IGNORE INTO muted_merchants (merchant) VALUES (?)').run(merchant);
		runRecurringDetection(db); // series (and its Concerns/Projection input) vanish now, not at next sync
		return { ok: true };
	},
	unmute: async ({ request }) => {
		const merchant = ((await request.formData()).get('merchant') as string)?.trim().toLowerCase();
		if (!merchant) return fail(400, { message: 'Merchant required' });
		db.prepare('DELETE FROM muted_merchants WHERE merchant = ?').run(merchant);
		runRecurringDetection(db);
		return { ok: true };
	}
};
