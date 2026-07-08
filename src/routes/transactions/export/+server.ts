import { db } from '$lib/server/db';
import { queryLedger, toCsv, amountsFromUrl } from '$lib/server/ledger';
import { parseFilters } from '$lib/server/filters';
import type { RequestHandler } from './$types';

/** CSV of the currently-filtered ledger view — data never locked in. */
export const GET: RequestHandler = ({ url }) => {
	const csv = toCsv(queryLedger(db, parseFilters(url.searchParams), amountsFromUrl(url)));
	return new Response(csv, {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': 'attachment; filename="money-tracker-export.csv"'
		}
	});
};
