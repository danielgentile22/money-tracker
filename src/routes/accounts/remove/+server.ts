import { json } from '@sveltejs/kit';
import { removeConnection } from '$lib/server/plaid';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const { connectionId } = (await request.json()) as { connectionId: number };
	await removeConnection(connectionId);
	return json({ ok: true });
};
