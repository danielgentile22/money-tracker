import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isBackfilling, backfillProgress } from '$lib/server/backfill';
import type { RequestHandler } from './$types';

// Polled by the Scans section while a scan runs — feeds the progress bar.
export const GET: RequestHandler = () =>
	json({ running: isBackfilling(), progress: backfillProgress(db) });
