import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { searchTransactions } from '$lib/server/ledger';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ url }) =>
	json({ results: searchTransactions(db, url.searchParams.get('q') ?? '') });
