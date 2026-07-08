import { redirect } from '@sveltejs/kit';
import { completeEnrollment } from '$lib/server/gmail';
import type { RequestHandler } from './$types';

// Google's localhost redirect lands here; success and failure both funnel back
// to Settings, which renders the outcome as a banner.
export const GET: RequestHandler = async ({ url }) => {
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state') ?? '';
	if (!code) {
		const reason = url.searchParams.get('error') ?? 'enrollment cancelled';
		redirect(303, `/settings?inbox_error=${encodeURIComponent(reason)}`);
	}
	let dest: string;
	try {
		const address = await completeEnrollment(url.origin, code, state);
		dest = `/settings?inbox_enrolled=${encodeURIComponent(address)}`;
	} catch (e) {
		dest = `/settings?inbox_error=${encodeURIComponent(e instanceof Error ? e.message : String(e))}`;
	}
	redirect(303, dest);
};
