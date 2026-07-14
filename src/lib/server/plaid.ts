import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from 'plaid';
import { getSecret, setSecret, deleteSecret } from './keychain';
import { db } from './db';
import { upsertAccounts, type PlaidSource, type SourceInvestmentTxn } from './sync';
import { mapAccount, mapTransaction, mapInvestmentTxn } from './plaid-map';

// sandbox | production — flipped at p1-11 cutover. Secrets differ per env.
export const PLAID_ENV = process.env.PLAID_ENV ?? 'sandbox';

export function plaidReady(): boolean {
	return getSecret('plaid-client-id') !== null && getSecret(`plaid-secret-${PLAID_ENV}`) !== null;
}

function client(): PlaidApi {
	const clientId = getSecret('plaid-client-id');
	const secret = getSecret(`plaid-secret-${PLAID_ENV}`);
	if (!clientId || !secret) {
		throw new Error(
			`Plaid keys missing from Keychain. Run:\n` +
				`  security add-generic-password -s money-tracker -a plaid-client-id -w <client_id>\n` +
				`  security add-generic-password -s money-tracker -a plaid-secret-${PLAID_ENV} -w <secret>`
		);
	}
	return new PlaidApi(
		new Configuration({
			basePath: PlaidEnvironments[PLAID_ENV],
			baseOptions: { headers: { 'PLAID-CLIENT-ID': clientId, 'PLAID-SECRET': secret } }
		})
	);
}

export function accessTokenFor(plaidItemId: string): string {
	const token = getSecret(`plaid-access-token-${plaidItemId}`);
	if (!token) throw new Error(`No access token in Keychain for Connection ${plaidItemId}`);
	return token;
}

/** Link token for a new Connection, or update-mode when re-linking a broken one. */
export async function createLinkToken(relinkConnectionId?: number): Promise<string> {
	const base = {
		user: { client_user_id: 'owner' },
		client_name: 'Money Tracker',
		country_codes: [CountryCode.Us],
		language: 'en'
	};
	let req;
	if (relinkConnectionId) {
		const row = db
			.prepare('SELECT plaid_item_id FROM connections WHERE id = ?')
			.get(relinkConnectionId) as { plaid_item_id: string } | undefined;
		if (!row) throw new Error(`No Connection ${relinkConnectionId}`);
		req = { ...base, access_token: accessTokenFor(row.plaid_item_id) };
	} else {
		// investments optional so institutions without the investments product still appear in Link;
		// max history depth is fixed at link time (default is only 90 days)
		req = {
			...base,
			products: [Products.Transactions],
			optional_products: [Products.Investments],
			transactions: { days_requested: 730 }
		};
	}
	const res = await client().linkTokenCreate(req);
	return res.data.link_token;
}

/** Exchange after Link success: store token in Keychain, upsert Connection, pull accounts. */
export async function exchangePublicToken(
	publicToken: string,
	institutionName: string
): Promise<number> {
	const res = await client().itemPublicTokenExchange({ public_token: publicToken });
	const { access_token, item_id } = res.data;
	setSecret(`plaid-access-token-${item_id}`, access_token);
	const connectionId = db
		.prepare(
			`INSERT INTO connections (institution_name, plaid_item_id) VALUES (?, ?)
			 ON CONFLICT (plaid_item_id) DO UPDATE SET institution_name = excluded.institution_name, health = 'healthy'
			 RETURNING id`
		)
		.pluck()
		.get(institutionName, item_id) as number;
	await refreshAccounts(connectionId);
	return connectionId;
}

/**
 * The real PlaidSource for the sync engine (fake ones live in tests).
 * Owner-signed cents happen here: Plaid's positive-means-outflow is flipped.
 */
export const realSource: PlaidSource = {
	async accounts(plaidItemId) {
		const res = await client().accountsBalanceGet({ access_token: accessTokenFor(plaidItemId) });
		return res.data.accounts.map(mapAccount);
	},
	async transactionsSync(plaidItemId, cursor) {
		const res = await client().transactionsSync({
			access_token: accessTokenFor(plaidItemId),
			cursor: cursor ?? undefined,
			count: 500
		});
		return {
			added: res.data.added.map(mapTransaction),
			modified: res.data.modified.map(mapTransaction),
			removed: res.data.removed.map((r) => ({ transaction_id: r.transaction_id! })),
			next_cursor: res.data.next_cursor,
			has_more: res.data.has_more
		};
	},
	async investmentsTransactions(plaidItemId) {
		const access_token = accessTokenFor(plaidItemId);
		const start_date = new Date(Date.now() - 730 * 86_400_000).toISOString().slice(0, 10);
		const end_date = new Date().toISOString().slice(0, 10);
		const out: SourceInvestmentTxn[] = [];
		let offset = 0;
		for (;;) {
			const res = await client().investmentsTransactionsGet({
				access_token,
				start_date,
				end_date,
				options: { count: 500, offset }
			});
			const batch = res.data.investment_transactions;
			for (const t of batch) out.push(mapInvestmentTxn(t));
			offset += batch.length;
			// p9-77: stop on an empty page even if total still exceeds offset —
			// a mid-pagination total/page mismatch would otherwise loop forever.
			if (batch.length === 0 || offset >= res.data.total_investment_transactions) break;
		}
		return out;
	}
};

/**
 * Fully remove a Connection: revoke the Item at Plaid (frees a Trial-plan
 * slot), delete the Keychain token, and drop the local rows (accounts,
 * transactions, snapshots cascade via FKs).
 */
export async function removeConnection(connectionId: number): Promise<void> {
	const row = db
		.prepare('SELECT plaid_item_id FROM connections WHERE id = ?')
		.get(connectionId) as { plaid_item_id: string } | undefined;
	if (!row) return;
	try {
		await client().itemRemove({ access_token: accessTokenFor(row.plaid_item_id) });
	} catch {
		// token already gone or Item already removed — still clean up locally
	}
	deleteSecret(`plaid-access-token-${row.plaid_item_id}`);
	db.transaction(() => {
		// a paired leg in another Connection points at these transactions via
		// transfer_peer_id (NO ACTION) — null it out before the cascade delete,
		// or the FK aborts removal. The surviving leg re-enters detection.
		db.prepare(
			`UPDATE transactions SET transfer_peer_id = NULL, is_transfer = 0, is_saved = 0
			 WHERE transfer_peer_id IN (
			   SELECT t.id FROM transactions t JOIN accounts a ON a.id = t.account_id
			   WHERE a.connection_id = ?)`
		).run(connectionId);
		db.prepare('DELETE FROM connections WHERE id = ?').run(connectionId);
		// review items whose Transaction just cascaded away
		db.prepare(
			`DELETE FROM review_items WHERE kind = 'transfer-ambiguity'
			 AND json_extract(payload, '$.txnId') NOT IN (SELECT id FROM transactions)`
		).run();
	})();
}

/** Pull accounts + current balances for one Connection and upsert them. */
export async function refreshAccounts(connectionId: number): Promise<void> {
	const row = db
		.prepare('SELECT plaid_item_id FROM connections WHERE id = ?')
		.get(connectionId) as { plaid_item_id: string } | undefined;
	if (!row) throw new Error(`No Connection ${connectionId}`);
	upsertAccounts(db, connectionId, await realSource.accounts(row.plaid_item_id));
}

export function setConnectionHealth(
	connectionId: number,
	health: 'healthy' | 'degraded' | 'broken',
	error?: string
): void {
	db.prepare('UPDATE connections SET health = ?, last_sync_error = ? WHERE id = ?').run(
		health,
		error ?? null,
		connectionId
	);
}
