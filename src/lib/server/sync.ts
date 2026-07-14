import type { Database } from 'better-sqlite3';
import { normalizeMerchant, categorize, matchRule, isUnresolved } from './categorizer';
import { loadRules, loadMap, otherCategoryId, applyRuleTags } from './categorize-db';

// The sync engine is generic over a PlaidSource so tests run against a fake
// (PRD: sync-engine tests use a fake Plaid client, no mocks of internals).

export type SourceAccount = {
	account_id: string;
	name: string;
	type: string;
	subtype: string | null;
	mask: string | null;
	current_balance_cents: number | null; // owner-signed: liabilities negative
	available_balance_cents: number | null;
};

/**
 * Plaid reports liability balances positive-means-owed; we store them negative
 * so rows, charts, and Σ-balances net worth all agree (p1-13).
 */
export function ownerSignedBalance(
	accountType: string,
	cents: number | null
): number | null {
	if (cents == null) return null;
	return accountType === 'credit' || accountType === 'loan' ? -cents : cents;
}

export type SourceTxn = {
	transaction_id: string;
	pending_transaction_id: string | null;
	account_id: string;
	date: string;
	name: string; // raw bank string
	merchant_name: string | null; // Plaid's cleaned merchant, when present
	amount_cents: number; // owner-signed: negative = money out
	pending: boolean;
	pfc_primary: string | null; // Plaid personal_finance_category
	pfc_detailed: string | null;
	pfc_confidence: string | null;
	payment_channel: string | null; // 'online' | 'in store' | 'other'
};

export type SyncPage = {
	added: SourceTxn[];
	modified: SourceTxn[];
	removed: { transaction_id: string }[];
	next_cursor: string;
	has_more: boolean;
};

export type SourceInvestmentTxn = {
	investment_transaction_id: string;
	account_id: string;
	date: string;
	name: string;
	amount_cents: number; // owner-signed: negative = money out
	internal: boolean; // buys/sells/dividends/fees — invisible to spending semantics
};

export interface PlaidSource {
	accounts(plaidItemId: string): Promise<SourceAccount[]>;
	transactionsSync(plaidItemId: string, cursor: string | null): Promise<SyncPage>;
	investmentsTransactions?(plaidItemId: string): Promise<SourceInvestmentTxn[]>;
}

export type SyncResult = {
	connectionId: number;
	ok: boolean;
	error?: string;
	newTxnIds?: number[]; // this sync's inserts — the LLM rung's batch (Pass B)
};

export function upsertAccounts(
	db: Database,
	connectionId: number,
	accounts: SourceAccount[]
): void {
	const upsert = db.prepare(
		`INSERT INTO accounts (connection_id, plaid_account_id, name, type, subtype, mask, current_balance_cents, available_balance_cents, active)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
		 ON CONFLICT (plaid_account_id) DO UPDATE SET
		   name = excluded.name, type = excluded.type, subtype = excluded.subtype, mask = excluded.mask,
		   current_balance_cents = excluded.current_balance_cents,
		   available_balance_cents = excluded.available_balance_cents, active = 1`
	);
	for (const a of accounts) {
		upsert.run(
			connectionId,
			a.account_id,
			a.name,
			a.type,
			a.subtype,
			a.mask,
			a.current_balance_cents,
			a.available_balance_cents
		);
	}
	// p9-00: any account Plaid no longer returns for this connection is closed or
	// deselected — mark it inactive so recordSnapshots/netWorthSeries stop feeding
	// it (and its now-stale balance) into net worth. An empty pull inactivates all
	// of them: keeping them active would let the runner re-snapshot stale balances
	// as fresh 'real' points (Plaid signals real failures by throwing, not by
	// returning []). They reactivate on the next sync that lists them.
	const ids = accounts.map((a) => a.account_id);
	const clause = ids.length > 0 ? ` AND plaid_account_id NOT IN (${ids.map(() => '?').join(',')})` : '';
	db.prepare(`UPDATE accounts SET active = 0 WHERE connection_id = ?${clause}`).run(connectionId, ...ids);
}

/**
 * One full sync for one Connection: pull everything first, then apply in a
 * single db transaction — an error anywhere leaves the ledger untouched and
 * the cursor unadvanced (no partial corruption).
 */
export async function syncConnection(
	db: Database,
	source: PlaidSource,
	connectionId: number
): Promise<SyncResult> {
	const conn = db
		.prepare('SELECT plaid_item_id, sync_cursor FROM connections WHERE id = ?')
		.get(connectionId) as { plaid_item_id: string; sync_cursor: string | null } | undefined;
	if (!conn) return { connectionId, ok: false, error: 'unknown connection' };

	try {
		const accounts = await source.accounts(conn.plaid_item_id);
		// investment Accounts don't speak /transactions/sync — brokerage-style
		// Connections take the investments path instead
		const hasCash = accounts.some((a) => a.type !== 'investment');
		const hasInvestment = accounts.some((a) => a.type === 'investment');
		const pages: SyncPage[] = [];
		let cursor = conn.sync_cursor;
		let hasMore = hasCash;
		while (hasMore) {
			const page = await source.transactionsSync(conn.plaid_item_id, cursor);
			pages.push(page);
			cursor = page.next_cursor;
			hasMore = page.has_more;
		}
		let invTxns: SourceInvestmentTxn[] = [];
		if (hasInvestment && source.investmentsTransactions) {
			try {
				invTxns = await source.investmentsTransactions(conn.plaid_item_id);
			} catch (e) {
				const code = (e as { response?: { data?: { error_code?: string } } })?.response?.data
					?.error_code;
				// Some institutions (e.g. with ride-along 529s) expose investment
				// balances but not investment transactions — skip, don't fail the sync.
				// Balances/Snapshots still flow; internal 529 activity is invisible anyway.
				if (code !== 'PRODUCTS_NOT_SUPPORTED' && code !== 'INVALID_PRODUCT') throw e;
			}
		}

		const newTxnIds: number[] = [];
		const apply = db.transaction(() => {
			upsertAccounts(db, connectionId, accounts);
			const accountIds = new Map(
				(
					db
						.prepare('SELECT id, plaid_account_id FROM accounts WHERE connection_id = ?')
						.all(connectionId) as { id: number; plaid_account_id: string }[]
				).map((r) => [r.plaid_account_id, r.id])
			);
			// categorization ladder (ADR-0006) runs on everything Plaid sends;
			// the upsert never overwrites a correction-, proposal-, or model-source
			// row's Category (owner judgment, or story 32's kept LLM assignment)
			const rules = loadRules(db);
			const map = loadMap(db);
			const fallback = otherCategoryId(db);
			const upsertTxn = db.prepare(
				`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, amount_cents, pending,
				   merchant, plaid_merchant_name, category_id, category_source,
				   plaid_category_primary, plaid_category_detailed, plaid_confidence, payment_channel, unresolved)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT (plaid_transaction_id) DO UPDATE SET
				   account_id = excluded.account_id, date = excluded.date, name = excluded.name,
				   amount_cents = excluded.amount_cents, pending = excluded.pending,
				   merchant = excluded.merchant, plaid_merchant_name = excluded.plaid_merchant_name,
				   plaid_category_primary = excluded.plaid_category_primary,
				   plaid_category_detailed = excluded.plaid_category_detailed,
				   plaid_confidence = excluded.plaid_confidence,
				   payment_channel = excluded.payment_channel,
				   category_id = CASE WHEN transactions.category_source IN ('correction', 'proposal', 'llm', 'llm+receipt')
				     THEN transactions.category_id ELSE excluded.category_id END,
				   category_source = CASE WHEN transactions.category_source IN ('correction', 'proposal', 'llm', 'llm+receipt')
				     THEN transactions.category_source ELSE excluded.category_source END,
				   unresolved = CASE WHEN transactions.category_source IN ('correction', 'proposal')
				     THEN 0 ELSE excluded.unresolved END`
			);
			// A paired transaction has an inbound transfer_peer_id FK (NO ACTION), so
			// deleting it would abort the sync — null out the surviving leg's pointer
			// first and reset its flags so detection re-judges the now-orphaned leg.
			const clearPeer = db.prepare(
				`UPDATE transactions SET transfer_peer_id = NULL, is_transfer = 0, is_saved = 0
				 WHERE transfer_peer_id = (SELECT id FROM transactions WHERE plaid_transaction_id = ?)`
			);
			const deleteTxn = db.prepare('DELETE FROM transactions WHERE plaid_transaction_id = ?');
			const existsTxn = db.prepare('SELECT 1 FROM transactions WHERE plaid_transaction_id = ?');
			const renamePending = db.prepare(
				'UPDATE transactions SET plaid_transaction_id = ? WHERE plaid_transaction_id = ?'
			);
			for (const page of pages) {
				for (const t of [...page.added, ...page.modified]) {
					const accountId = accountIds.get(t.account_id);
					if (!accountId) throw new Error(`transaction for unknown account ${t.account_id}`);
					// a posted transaction supersedes its pending row: rename that row in
					// place to the posted id (p9-01) instead of delete+reinsert, so the
					// owner's Correction, Tags, and Receipt state carry over — the upsert
					// below then runs as an ON CONFLICT UPDATE and its category CASE keeps
					// owner-set sources. ponytail: a Plaid replay where the posted id
					// already exists would hit the UNIQUE constraint and abort the sync
					// (cursor unadvanced, retryable) — no silent corruption.
					if (t.pending_transaction_id)
						renamePending.run(t.transaction_id, t.pending_transaction_id);
					const merchant = normalizeMerchant(t.name, t.merchant_name);
					const facts = {
						merchant,
						amount_cents: t.amount_cents,
						pfc_primary: t.pfc_primary,
						pfc_detailed: t.pfc_detailed
					};
					const cat = categorize(facts, rules, map);
					const unresolved = isUnresolved(
						facts,
						t.pfc_confidence,
						matchRule(facts, rules) !== null
					);
					const isNew = !existsTxn.get(t.transaction_id);
					const info = upsertTxn.run(
						accountId,
						t.transaction_id,
						t.date,
						t.name,
						t.amount_cents,
						t.pending ? 1 : 0,
						merchant,
						t.merchant_name,
						cat?.categoryId ?? fallback,
						cat?.source ?? 'plaid',
						t.pfc_primary,
						t.pfc_detailed,
						t.pfc_confidence,
						t.payment_channel,
						unresolved ? 1 : 0
					);
					if (isNew) newTxnIds.push(Number(info.lastInsertRowid));
				}
				for (const r of page.removed) {
					clearPeer.run(r.transaction_id);
					deleteTxn.run(r.transaction_id);
				}
			}
			// Drop open transfer-ambiguity items whose subject transaction just
			// vanished, so the review queue never renders (or 500s on) a dead id.
			db.prepare(
				`DELETE FROM review_items WHERE kind = 'transfer-ambiguity' AND status = 'open'
				 AND json_extract(payload, '$.txnId') NOT IN (SELECT id FROM transactions)`
			).run();
			applyRuleTags(db); // Rules with Tags label arrivals just like they categorize them
			// investment activity: internal rows are invisible (no ladder, no
			// Unresolved, no Transfer pairing); external legs (contributions,
			// withdrawals) pair in p1-06's detection like any other Transaction
			const upsertInv = db.prepare(
				`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, amount_cents, pending,
				   merchant, category_id, category_source, unresolved, is_investment_activity)
				 VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'plaid', 0, ?)
				 ON CONFLICT (plaid_transaction_id) DO UPDATE SET
				   date = excluded.date, name = excluded.name, amount_cents = excluded.amount_cents,
				   is_investment_activity = excluded.is_investment_activity`
			);
			for (const t of invTxns) {
				const accountId = accountIds.get(t.account_id);
				if (!accountId) throw new Error(`investment txn for unknown account ${t.account_id}`);
				upsertInv.run(
					accountId,
					t.investment_transaction_id,
					t.date,
					t.name,
					t.amount_cents,
					normalizeMerchant(t.name, null),
					fallback,
					t.internal ? 1 : 0
				);
			}
			db.prepare(
				`UPDATE connections SET sync_cursor = ?, last_synced_at = datetime('now'),
				 health = 'healthy', last_sync_error = NULL WHERE id = ?`
			).run(cursor, connectionId);
		});
		apply();
		return { connectionId, ok: true, newTxnIds };
	} catch (e) {
		const data = (e as { response?: { data?: { error_code?: string; error_message?: string } } })
			?.response?.data;
		const code = data?.error_code;
		let message = code
			? `${code}: ${data?.error_message ?? ''}`.trim()
			: e instanceof Error
				? e.message
				: String(e);
		// no webhooks (local app): a just-linked Item often isn't ready yet
		if (code === 'PRODUCT_NOT_READY')
			message += ' — Plaid is still preparing this Connection; hit Refresh again in a minute or two.';
		const health =
			code === 'ITEM_LOGIN_REQUIRED' ||
			code === 'ITEM_LOCKED' ||
			code === 'ITEM_NOT_FOUND' ||
			code === 'ACCESS_NOT_GRANTED'
				? 'broken'
				: 'degraded';
		db.prepare('UPDATE connections SET health = ?, last_sync_error = ? WHERE id = ?').run(
			health,
			message,
			connectionId
		);
		return { connectionId, ok: false, error: message };
	}
}

export async function syncAll(db: Database, source: PlaidSource): Promise<SyncResult[]> {
	const ids = db.prepare('SELECT id FROM connections ORDER BY id').all() as { id: number }[];
	const results: SyncResult[] = [];
	for (const { id } of ids) results.push(await syncConnection(db, source, id));
	return results;
}
