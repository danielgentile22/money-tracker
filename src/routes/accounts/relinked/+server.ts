import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { setConnectionHealth, refreshAccounts } from '$lib/server/plaid';
import { recordSnapshots } from '$lib/server/balances';
import type { RequestHandler } from './$types';

/** After Link update mode succeeds, the existing access token works again. */
export const POST: RequestHandler = async ({ request }) => {
	const { connectionId } = (await request.json()) as { connectionId: number };
	setConnectionHealth(connectionId, 'healthy');
	await refreshAccounts(connectionId)
		// p9-43: snapshot the just-refreshed balances so /accounts' headline number
		// and its balance chart agree immediately, not only after the next sync.
		.then(() => recordSnapshots(db, undefined, [connectionId]))
		.catch(() => {
			// balances refresh on next sync if this one hiccups; health already restored
		});
	return json({ ok: true });
};
