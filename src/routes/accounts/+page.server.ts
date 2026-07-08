import { db } from '$lib/server/db';
import { plaidReady, PLAID_ENV } from '$lib/server/plaid';
import { balanceSeries, type SeriesPoint } from '$lib/server/balances';
import type { PageServerLoad } from './$types';

export type ConnectionRow = {
	id: number;
	institution_name: string;
	health: 'healthy' | 'degraded' | 'broken';
	last_synced_at: string | null;
	last_sync_error: string | null;
};

export type AccountRow = {
	id: number;
	connection_id: number;
	name: string;
	type: string;
	subtype: string | null;
	mask: string | null;
	current_balance_cents: number | null;
};

export const load: PageServerLoad = () => {
	const connections = db
		.prepare(
			'SELECT id, institution_name, health, last_synced_at, last_sync_error FROM connections ORDER BY id'
		)
		.all() as ConnectionRow[];
	const accounts = db
		.prepare(
			'SELECT id, connection_id, name, type, subtype, mask, current_balance_cents FROM accounts ORDER BY id'
		)
		.all() as AccountRow[];
	const series: Record<number, SeriesPoint[]> = {};
	for (const a of accounts) series[a.id] = balanceSeries(db, a.id);

	return { connections, accounts, series, plaidReady: plaidReady(), plaidEnv: PLAID_ENV };
};
