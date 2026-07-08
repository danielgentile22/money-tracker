import { json, error } from '@sveltejs/kit';
import { createLinkToken } from '$lib/server/plaid';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const { connectionId } = (await request.json().catch(() => ({}))) as {
		connectionId?: number;
	};
	try {
		return json({ link_token: await createLinkToken(connectionId) });
	} catch (e) {
		error(500, e instanceof Error ? e.message : 'link token failed');
	}
};
