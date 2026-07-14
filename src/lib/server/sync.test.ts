import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import { syncConnection, upsertAccounts } from './sync';
import type { PlaidSource, SourceTxn, SyncPage, SourceAccount } from './sync';

const CHECKING: SourceAccount = {
	account_id: 'acc-checking',
	name: 'Checking',
	type: 'depository',
	subtype: 'checking',
	mask: '0001',
	current_balance_cents: 100_000,
	available_balance_cents: 100_000
};

function makeDb() {
	const db = new Database(':memory:');
	migrate(db);
	db.prepare("INSERT INTO connections (institution_name, plaid_item_id) VALUES ('Test Bank', 'item-1')").run();
	return db;
}

function txn(id: string, over: Partial<SourceTxn> = {}): SourceTxn {
	return {
		transaction_id: id,
		pending_transaction_id: null,
		account_id: 'acc-checking',
		date: '2026-06-01',
		name: 'COFFEE SHOP',
		merchant_name: null,
		amount_cents: -450,
		pending: false,
		pfc_primary: null,
		pfc_detailed: null,
		pfc_confidence: null,
		payment_channel: null,
		...over
	};
}

function page(over: Partial<SyncPage> = {}): SyncPage {
	return { added: [], modified: [], removed: [], next_cursor: 'c-next', has_more: false, ...over };
}

/** Fake Plaid: serves the given pages in order, records the cursor of each call. */
function fakeSource(pages: (SyncPage | Error)[], cursorLog: (string | null)[] = []): PlaidSource {
	let i = 0;
	return {
		accounts: async () => [CHECKING],
		transactionsSync: async (_item, cursor) => {
			cursorLog.push(cursor);
			const next = pages[i++] ?? page({ next_cursor: cursor ?? '' });
			if (next instanceof Error) throw next;
			return next;
		}
	};
}

function allTxns(db: Database.Database) {
	return db
		.prepare('SELECT plaid_transaction_id AS pid, amount_cents, pending FROM transactions ORDER BY pid')
		.all() as { pid: string; amount_cents: number; pending: number }[];
}

function connection(db: Database.Database) {
	return db.prepare('SELECT sync_cursor, health, last_synced_at, last_sync_error FROM connections WHERE id = 1').get() as {
		sync_cursor: string | null;
		health: string;
		last_synced_at: string | null;
		last_sync_error: string | null;
	};
}

test('first sync inserts added transactions and persists the cursor', async () => {
	const db = makeDb();
	const log: (string | null)[] = [];
	const source = fakeSource([page({ added: [txn('t-1'), txn('t-2')], next_cursor: 'c-1' })], log);

	const result = await syncConnection(db, source, 1);

	expect(result.ok).toBe(true);
	expect(log).toEqual([null]);
	expect(allTxns(db).map((t) => t.pid)).toEqual(['t-1', 't-2']);
	expect(connection(db).sync_cursor).toBe('c-1');
	expect(connection(db).health).toBe('healthy');
	expect(connection(db).last_synced_at).not.toBeNull();
});

test('removing a paired leg nulls its peer and purges its review item, no FK wedge (#02/#38)', async () => {
	const db = makeDb();
	const SAVINGS: SourceAccount = {
		...CHECKING,
		account_id: 'acc-savings',
		name: 'Savings',
		subtype: 'savings'
	};
	// seed both accounts + a confirmed cross-account transfer pair by hand
	const acct = db.prepare(
		'INSERT INTO accounts (connection_id, plaid_account_id, name, type, subtype) VALUES (1, ?, ?, ?, ?)'
	);
	const chk = acct.run('acc-checking', 'Checking', 'depository', 'checking').lastInsertRowid as number;
	const sav = acct.run('acc-savings', 'Savings', 'depository', 'savings').lastInsertRowid as number;
	const ins = db.prepare(
		"INSERT INTO transactions (account_id, plaid_transaction_id, date, name, amount_cents) VALUES (?, ?, '2026-06-01', 'X', ?) RETURNING id"
	);
	const outId = ins.pluck().get(chk, 't-out', -50_000) as number;
	const inId = ins.pluck().get(sav, 't-in', 50_000) as number;
	db.prepare('UPDATE transactions SET is_transfer = 1, is_saved = 1, transfer_peer_id = ? WHERE id = ?').run(inId, outId);
	db.prepare('UPDATE transactions SET is_transfer = 1, is_saved = 1, transfer_peer_id = ? WHERE id = ?').run(outId, inId);
	db.prepare("INSERT INTO review_items (kind, payload) VALUES ('transfer-ambiguity', ?)").run(
		JSON.stringify({ txnId: outId, candidateIds: [] })
	);

	const source: PlaidSource = {
		accounts: async () => [CHECKING, SAVINGS],
		transactionsSync: async () => page({ removed: [{ transaction_id: 't-out' }] })
	};
	const result = await syncConnection(db, source, 1);

	expect(result.ok).toBe(true); // the FK did not abort the sync
	expect(db.prepare("SELECT COUNT(*) FROM transactions WHERE plaid_transaction_id = 't-out'").pluck().get()).toBe(0);
	expect(
		db.prepare('SELECT is_transfer, is_saved, transfer_peer_id FROM transactions WHERE id = ?').get(inId)
	).toEqual({ is_transfer: 0, is_saved: 0, transfer_peer_id: null });
	expect(db.prepare('SELECT COUNT(*) FROM review_items').pluck().get()).toBe(0);
});

test('second sync starts from the persisted cursor', async () => {
	const db = makeDb();
	await syncConnection(db, fakeSource([page({ added: [txn('t-1')], next_cursor: 'c-1' })]), 1);

	const log: (string | null)[] = [];
	await syncConnection(db, fakeSource([page({ added: [txn('t-2')], next_cursor: 'c-2' })], log), 1);

	expect(log).toEqual(['c-1']);
	expect(connection(db).sync_cursor).toBe('c-2');
});

test('multi-page sync applies all pages and lands on the final cursor', async () => {
	const db = makeDb();
	const source = fakeSource([
		page({ added: [txn('t-1')], next_cursor: 'c-mid', has_more: true }),
		page({ added: [txn('t-2')], next_cursor: 'c-end' })
	]);

	await syncConnection(db, source, 1);

	expect(allTxns(db).map((t) => t.pid)).toEqual(['t-1', 't-2']);
	expect(connection(db).sync_cursor).toBe('c-end');
});

test('re-syncing the same transactions produces no duplicates', async () => {
	const db = makeDb();
	const added = [txn('t-1'), txn('t-2')];
	await syncConnection(db, fakeSource([page({ added, next_cursor: 'c-1' })]), 1);
	await syncConnection(db, fakeSource([page({ added, next_cursor: 'c-2' })]), 1);

	expect(allTxns(db)).toHaveLength(2);
});

test('modified transactions update; removed transactions disappear', async () => {
	const db = makeDb();
	await syncConnection(db, fakeSource([page({ added: [txn('t-1'), txn('t-2')] })]), 1);

	await syncConnection(
		db,
		fakeSource([
			page({
				modified: [txn('t-1', { amount_cents: -999 })],
				removed: [{ transaction_id: 't-2' }]
			})
		]),
		1
	);

	expect(allTxns(db)).toEqual([{ pid: 't-1', amount_cents: -999, pending: 0 }]);
});

test('a posted transaction replaces the pending one it supersedes', async () => {
	const db = makeDb();
	await syncConnection(db, fakeSource([page({ added: [txn('t-pending', { pending: true })] })]), 1);
	expect(allTxns(db)).toEqual([{ pid: 't-pending', amount_cents: -450, pending: 1 }]);

	await syncConnection(
		db,
		fakeSource([
			page({ added: [txn('t-posted', { pending_transaction_id: 't-pending', amount_cents: -475 })] })
		]),
		1
	);

	expect(allTxns(db)).toEqual([{ pid: 't-posted', amount_cents: -475, pending: 0 }]);
});

test('an error mid-pagination commits nothing and marks the Connection degraded', async () => {
	const db = makeDb();
	await syncConnection(db, fakeSource([page({ added: [txn('t-1')], next_cursor: 'c-1' })]), 1);

	const source = fakeSource([
		page({ added: [txn('t-2')], next_cursor: 'c-mid', has_more: true }),
		new Error('PLAID_ERROR: something transient')
	]);
	const result = await syncConnection(db, source, 1);

	expect(result.ok).toBe(false);
	expect(allTxns(db).map((t) => t.pid)).toEqual(['t-1']); // t-2 not committed
	expect(connection(db).sync_cursor).toBe('c-1'); // cursor unadvanced
	expect(connection(db).health).toBe('degraded');
	expect(connection(db).last_sync_error).toContain('PLAID_ERROR');
});

test('a re-auth error marks the Connection broken', async () => {
	const db = makeDb();
	const err = Object.assign(new Error('login required'), {
		response: { data: { error_code: 'ITEM_LOGIN_REQUIRED' } }
	});
	const result = await syncConnection(db, fakeSource([err]), 1);

	expect(result.ok).toBe(false);
	expect(connection(db).health).toBe('broken');
});

test('newTxnIds reports only this sync\'s inserts — the LLM rung\'s batch', async () => {
	const db = makeDb();
	const first = await syncConnection(db, fakeSource([page({ added: [txn('t-1'), txn('t-2')] })]), 1);
	expect(first.newTxnIds).toHaveLength(2);

	const second = await syncConnection(
		db,
		fakeSource([page({ added: [txn('t-3')], modified: [txn('t-1', { amount_cents: -999 })] })]),
		1
	);
	expect(second.newTxnIds).toHaveLength(1); // the modified row is not new
});

test('a Correction on a pending row survives the charge posting (p9-01)', async () => {
	const db = makeDb();
	await syncConnection(db, fakeSource([page({ added: [txn('t-pending', { pending: true })] })]), 1);
	const groceries = db.prepare("SELECT id FROM categories WHERE name = 'Groceries'").pluck().get();
	db.prepare(
		"UPDATE transactions SET category_id = ?, category_source = 'correction', unresolved = 0 WHERE plaid_transaction_id = 't-pending'"
	).run(groceries);

	await syncConnection(
		db,
		fakeSource([page({ added: [txn('t-posted', { pending_transaction_id: 't-pending' })] })]),
		1
	);

	const row = db
		.prepare(
			'SELECT plaid_transaction_id AS pid, category_id, category_source, pending FROM transactions'
		)
		.get();
	expect(row).toEqual({
		pid: 't-posted',
		category_id: groceries,
		category_source: 'correction',
		pending: 0
	});
});

test('Tags on a pending row survive the charge posting (p9-01)', async () => {
	const db = makeDb();
	await syncConnection(db, fakeSource([page({ added: [txn('t-pending', { pending: true })] })]), 1);
	const txnId = db
		.prepare("SELECT id FROM transactions WHERE plaid_transaction_id = 't-pending'")
		.pluck()
		.get();
	db.prepare("INSERT INTO tags (name) VALUES ('reimbursable')").run();
	const tagId = db.prepare("SELECT id FROM tags WHERE name = 'reimbursable'").pluck().get();
	db.prepare('INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)').run(txnId, tagId);

	await syncConnection(
		db,
		fakeSource([page({ added: [txn('t-posted', { pending_transaction_id: 't-pending' })] })]),
		1
	);

	const postedId = db
		.prepare("SELECT id FROM transactions WHERE plaid_transaction_id = 't-posted'")
		.pluck()
		.get();
	expect(
		db.prepare('SELECT tag_id FROM transaction_tags WHERE transaction_id = ?').pluck().all(postedId)
	).toEqual([tagId]);
});

test('Receipt match state on a pending row survives the charge posting (p9-01)', async () => {
	const db = makeDb();
	await syncConnection(db, fakeSource([page({ added: [txn('t-pending', { pending: true })] })]), 1);
	db.prepare(
		"UPDATE transactions SET receipt_search_state = 'matched', receipt_json = '{\"x\":1}' WHERE plaid_transaction_id = 't-pending'"
	).run();

	await syncConnection(
		db,
		fakeSource([page({ added: [txn('t-posted', { pending_transaction_id: 't-pending' })] })]),
		1
	);

	expect(
		db
			.prepare(
				"SELECT receipt_search_state AS s, receipt_json AS j FROM transactions WHERE plaid_transaction_id = 't-posted'"
			)
			.get()
	).toEqual({ s: 'matched', j: '{"x":1}' });
});

const acct = (id: string, over: Partial<SourceAccount> = {}): SourceAccount => ({
	account_id: id,
	name: id,
	type: 'depository',
	subtype: 'checking',
	mask: null,
	current_balance_cents: 100_000,
	available_balance_cents: 100_000,
	...over
});

const activeMap = (db: Database.Database) =>
	Object.fromEntries(
		(
			db.prepare('SELECT plaid_account_id AS pid, active FROM accounts').all() as {
				pid: string;
				active: number;
			}[]
		).map((r) => [r.pid, r.active])
	);

test('an account Plaid stops returning is marked inactive; a returning one reactivates (p9-00)', () => {
	const db = makeDb();
	upsertAccounts(db, 1, [acct('a'), acct('b')]);
	expect(activeMap(db)).toEqual({ a: 1, b: 1 });

	upsertAccounts(db, 1, [acct('a')]); // b vanished from the Plaid item
	expect(activeMap(db)).toEqual({ a: 1, b: 0 });

	upsertAccounts(db, 1, [acct('a'), acct('b')]); // b comes back
	expect(activeMap(db)).toEqual({ a: 1, b: 1 });
});

test('an empty account pull marks all the connection\'s accounts inactive (p9-00)', () => {
	const db = makeDb();
	upsertAccounts(db, 1, [acct('a'), acct('b')]);
	// Plaid returns no accounts: they must go inactive so the runner does not
	// re-snapshot their now-stale balances as fresh 'real' points.
	upsertAccounts(db, 1, []);
	expect(activeMap(db)).toEqual({ a: 0, b: 0 });

	// they reactivate once Plaid lists them again
	upsertAccounts(db, 1, [acct('a'), acct('b')]);
	expect(activeMap(db)).toEqual({ a: 1, b: 1 });
});

test('a modified event never wipes an LLM assignment back to the Plaid map', async () => {
	const db = makeDb();
	await syncConnection(db, fakeSource([page({ added: [txn('t-1')] })]), 1);
	const coffee = db.prepare("SELECT id FROM categories WHERE name = 'Coffee'").pluck().get();
	db.prepare("UPDATE transactions SET category_id = ?, category_source = 'llm' WHERE plaid_transaction_id = 't-1'").run(coffee);

	await syncConnection(db, fakeSource([page({ modified: [txn('t-1', { amount_cents: -999 })] })]), 1);

	const row = db
		.prepare("SELECT category_id, category_source FROM transactions WHERE plaid_transaction_id = 't-1'")
		.get() as { category_id: number; category_source: string };
	expect(row).toEqual({ category_id: coffee, category_source: 'llm' });
});
