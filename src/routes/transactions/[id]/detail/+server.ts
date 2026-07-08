import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { getTransactionDetail } from '$lib/server/transaction-detail';
import type { RequestHandler } from './$types';

// Fetched lazily when a ledger row is opened — the list never pays for detail.
export const GET: RequestHandler = ({ params }) => {
	try {
		return json(getTransactionDetail(db, Number(params.id)));
	} catch {
		error(404, `no Transaction ${params.id}`);
	}
};
