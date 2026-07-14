import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import { runSyncPipeline } from './sync-runner';
import { localToday } from './balances';
import type { PlaidSource, SourceAccount, SourceTxn } from './sync';
import type { ReceiptSource } from './gmail';
import type { Llm } from './llm';

// The composed pipeline (p9-34): ordering, the no-Inbox receipt gate, fail-soft
// steps, and the ok-connections-only snapshot filter (p9-09). Fully injected —
// the fakes stand in for Plaid/Gmail/Anthropic; the db is in-memory.

function makeDb(connCount: number): Database.Database {
	const db = new Database(':memory:');
	migrate(db);
	for (let i = 1; i <= connCount; i++)
		db.prepare('INSERT INTO connections (institution_name, plaid_item_id) VALUES (?, ?)').run(
			`Bank ${i}`,
			`item-${i}`
		);
	return db;
}

const checkingFor = (item: string): SourceAccount => ({
	account_id: `acc-${item}`,
	name: 'Checking',
	type: 'depository',
	subtype: 'checking',
	mask: null,
	current_balance_cents: 100_000,
	available_balance_cents: 100_000
});

const spendFor = (item: string): SourceTxn => ({
	transaction_id: `txn-${item}`,
	pending_transaction_id: null,
	account_id: `acc-${item}`,
	date: '2026-06-01',
	name: 'COFFEE',
	merchant_name: null,
	amount_cents: -450,
	pending: false,
	pfc_primary: null,
	pfc_detailed: null,
	pfc_confidence: null,
	payment_channel: null
});

function fakeSource(opts: { throwItems?: string[] } = {}): PlaidSource {
	return {
		accounts: async (item) => {
			if (opts.throwItems?.includes(item)) throw new Error(`${item} down`);
			return [checkingFor(item)];
		},
		transactionsSync: async (item) => ({
			added: [spendFor(item)],
			modified: [],
			removed: [],
			next_cursor: 'c',
			has_more: false
		})
	};
}

function recordingReceipts(): { source: ReceiptSource; calls: () => number } {
	let n = 0;
	return {
		source: {
			searchReceipts: async () => {
				n++;
				return [];
			}
		},
		calls: () => n
	};
}

const quietLlm: Llm = async () => '';
const throwingLlm: Llm = async () => {
	throw new Error('boom');
};

test('receipt resolution is skipped when no Inbox is connected (p9-34)', async () => {
	const db = makeDb(1);
	const receipts = recordingReceipts();
	await runSyncPipeline(db, fakeSource(), receipts.source, quietLlm);
	expect(receipts.calls()).toBe(0);
});

test('a throwing LLM never fails the sync (p9-34)', async () => {
	const db = makeDb(1);
	const results = await runSyncPipeline(db, fakeSource(), recordingReceipts().source, throwingLlm);
	expect(results.map((r) => ({ id: r.connectionId, ok: r.ok }))).toEqual([{ id: 1, ok: true }]);
});

test('a broken connection is not snapshotted; the healthy one is (p9-09)', async () => {
	const db = makeDb(2);
	// connection 2 synced successfully before: it holds an account with a now-stale balance
	db.prepare(
		`INSERT INTO accounts (connection_id, plaid_account_id, name, type, current_balance_cents, active)
		 VALUES (2, 'stale', 'Stale', 'depository', 77_000, 1)`
	).run();

	const results = await runSyncPipeline(
		db,
		fakeSource({ throwItems: ['item-2'] }), // connection 2 is down this run
		recordingReceipts().source,
		quietLlm
	);

	expect(results.find((r) => r.connectionId === 2)?.ok).toBe(false);
	const today = localToday();
	const snapsFor = (conn: number) =>
		db
			.prepare(
				'SELECT COUNT(*) FROM snapshots s JOIN accounts a ON a.id = s.account_id WHERE a.connection_id = ? AND s.date = ?'
			)
			.pluck()
			.get(conn, today) as number;

	expect(snapsFor(1)).toBeGreaterThan(0); // healthy connection: fresh snapshot
	expect(snapsFor(2)).toBe(0); // broken connection: stale balance not stamped as fresh 'real'
});
