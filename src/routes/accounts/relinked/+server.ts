import { json } from '@sveltejs/kit';
import { setConnectionHealth, refreshAccounts } from '$lib/server/plaid';
import type { RequestHandler } from './$types';

/** After Link update mode succeeds, the existing access token works again. */
export const POST: RequestHandler = async ({ request }) => {
	const { connectionId } = (await request.json()) as { connectionId: number };
	setConnectionHealth(connectionId, 'healthy');
	await refreshAccounts(connectionId).catch(() => {
		// balances refresh on next sync if this one hiccups; health already restored
	});
	return json({ ok: true });
};
