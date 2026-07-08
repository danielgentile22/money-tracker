import { json, error } from '@sveltejs/kit';
import { exchangePublicToken } from '$lib/server/plaid';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const { public_token, institution_name } = (await request.json()) as {
		public_token: string;
		institution_name: string;
	};
	if (!public_token) error(400, 'public_token required');
	try {
		const id = await exchangePublicToken(public_token, institution_name ?? 'Unknown');
		return json({ connection_id: id });
	} catch (e) {
		error(500, e instanceof Error ? e.message : 'exchange failed');
	}
};
