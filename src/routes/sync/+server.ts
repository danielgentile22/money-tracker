import { json } from '@sveltejs/kit';
import { runSync } from '$lib/server/sync-runner';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async () => json({ results: await runSync() });
