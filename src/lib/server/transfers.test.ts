import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import { detectTransfers, isAssetAccount, type TransferTxn } from './transfers';
import {
	runTransferDetection,
	approveReviewItem,
	approveLoneLeg,
	rejectReviewItem,
	reopenReviewItem
} from './transfers-db';

const t = (id: number, over: Partial<TransferTxn> = {}): TransferTxn => ({
	id,
	account_id: 1,
	date: '2026-06-10',
	amount_cents: -50_000,
	transfer_signal: false,
	...over
});

// --- pure pairing ---

test('a clean checking→savings pair is detected', () => {
	const result = detectTransfers(
		[t(1, { account_id: 1 }), t(2, { account_id: 2, amount_cents: 50_000, date: '2026-06-11' })],
		{ windowDays: 4 }
	);
	expect(result.pairs).toEqual([{ outId: 1, inId: 2 }]);
	expect(result.ambiguous).toEqual([]);
});

test('amounts differing → not paired', () => {
	const result = detectTransfers(
		[t(1), t(2, { account_id: 2, amount_cents: 49_900 })],
		{ windowDays: 4 }
	);
	expect(result.pairs).toEqual([]);
});

test('outside the date window → not paired', () => {
	const result = detectTransfers(
		[t(1, { date: '2026-06-01' }), t(2, { account_id: 2, amount_cents: 50_000, date: '2026-06-09' })],
		{ windowDays: 4 }
	);
	expect(result.pairs).toEqual([]);
});

test('same-account opposite signs → not paired', () => {
	const result = detectTransfers([t(1), t(2, { amount_cents: 50_000 })], { windowDays: 4 });
	expect(result.pairs).toEqual([]);
});

test('multiple candidate partners → ambiguous, nothing auto-paired', () => {
	const result = detectTransfers(
		[
			t(1),
			t(2, { account_id: 2, amount_cents: 50_000 }),
			t(3, { account_id: 3, amount_cents: 50_000 })
		],
		{ windowDays: 4 }
	);
	expect(result.pairs).toEqual([]);
	expect(result.ambiguous).toEqual([{ txnId: 1, candidateIds: [2, 3] }]);
});

test('Plaid-flagged legs with no partner → ambiguous with empty candidates', () => {
	const result = detectTransfers(
		[t(1, { transfer_signal: true }), t(2, { account_id: 2, amount_cents: 12_345, transfer_signal: true })],
		{ windowDays: 4 }
	);
	expect(result.pairs).toEqual([]);
	expect(result.ambiguous).toEqual([
		{ txnId: 1, candidateIds: [] },
		{ txnId: 2, candidateIds: [] }
	]);
});

test('isAssetAccount: savings/529/investment yes, checking/credit no', () => {
	expect(isAssetAccount('depository', 'savings')).toBe(true);
	expect(isAssetAccount('investment', '529')).toBe(true);
	expect(isAssetAccount('investment', 'brokerage')).toBe(true);
	expect(isAssetAccount('depository', 'checking')).toBe(false);
	expect(isAssetAccount('credit', 'credit card')).toBe(false);
});

// --- db integration ---

function makeDb() {
	const db = new Database(':memory:');
	migrate(db);
	db.prepare("INSERT INTO connections (institution_name, plaid_item_id) VALUES ('B', 'i')").run();
	const acct = db.prepare(
		'INSERT INTO accounts (connection_id, plaid_account_id, name, type, subtype) VALUES (1, ?, ?, ?, ?)'
	);
	acct.run('a-checking', 'Checking', 'depository', 'checking');
	acct.run('a-savings', 'Savings', 'depository', 'savings');
	acct.run('a-card', 'Credit Card', 'credit', 'credit card');
	return db;
}

function insertTxn(
	db: Database.Database,
	pid: string,
	accountId: number,
	amountCents: number,
	date = '2026-06-10',
	pfcPrimary: string | null = null
): number {
	return db
		.prepare(
			`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, amount_cents, plaid_category_primary)
			 VALUES (?, ?, ?, 'TRANSFER', ?, ?) RETURNING id`
		)
		.pluck()
		.get(accountId, pid, date, amountCents, pfcPrimary) as number;
}

function flags(db: Database.Database, id: number) {
	return db
		.prepare('SELECT is_transfer, is_saved, transfer_peer_id FROM transactions WHERE id = ?')
		.get(id) as { is_transfer: number; is_saved: number; transfer_peer_id: number | null };
}

test('savings contribution pairs and the asset leg is marked saved', () => {
	const db = makeDb();
	const out = insertTxn(db, 'p-out', 1, -50_000);
	const inn = insertTxn(db, 'p-in', 2, 50_000, '2026-06-11');

	runTransferDetection(db);

	expect(flags(db, out)).toEqual({ is_transfer: 1, is_saved: 0, transfer_peer_id: inn });
	expect(flags(db, inn)).toEqual({ is_transfer: 1, is_saved: 1, transfer_peer_id: out });
});

test('credit-card payment pairs as Transfer, both legs flagged, none saved', () => {
	const db = makeDb();
	const out = insertTxn(db, 'p-out', 1, -84_200);
	const inn = insertTxn(db, 'p-in', 3, 84_200);

	runTransferDetection(db);

	expect(flags(db, out).is_transfer).toBe(1);
	expect(flags(db, inn)).toEqual({ is_transfer: 1, is_saved: 0, transfer_peer_id: out });
});

test('ambiguity lands one open review item; re-running does not duplicate it', () => {
	const db = makeDb();
	insertTxn(db, 'p-out', 1, -50_000);
	insertTxn(db, 'p-in1', 2, 50_000);
	insertTxn(db, 'p-in2', 3, 50_000);

	runTransferDetection(db);
	runTransferDetection(db);

	const items = db
		.prepare("SELECT status FROM review_items WHERE kind = 'transfer-ambiguity'")
		.all() as { status: string }[];
	expect(items).toEqual([{ status: 'open' }]);
});

test('approve pairs the chosen candidate; reject keeps legs independent forever', () => {
	const db = makeDb();
	const out = insertTxn(db, 'p-out', 1, -50_000);
	const in1 = insertTxn(db, 'p-in1', 2, 50_000);
	const in2 = insertTxn(db, 'p-in2', 3, 50_000);
	runTransferDetection(db);
	const itemId = db.prepare('SELECT id FROM review_items').pluck().get() as number;

	approveReviewItem(db, itemId, in1);
	expect(flags(db, out).transfer_peer_id).toBe(in1);
	expect(flags(db, in1).is_saved).toBe(1); // savings account leg
	expect(flags(db, in2).is_transfer).toBe(0);

	// rejected ambiguity never re-enqueues or auto-pairs
	const db2 = makeDb();
	const out2 = insertTxn(db2, 'q-out', 1, -70_000);
	insertTxn(db2, 'q-in1', 2, 70_000);
	insertTxn(db2, 'q-in2', 3, 70_000);
	runTransferDetection(db2);
	const item2 = db2.prepare('SELECT id FROM review_items').pluck().get() as number;
	rejectReviewItem(db2, item2);
	runTransferDetection(db2);
	expect(flags(db2, out2).is_transfer).toBe(0);
	expect(db2.prepare('SELECT COUNT(*) FROM review_items').pluck().get()).toBe(1);
});

test('a lone leg approved as one-sided Transfer is excluded and optionally saved', () => {
	const db = makeDb();
	// 529 contribution: only the checking out-leg exists (institution sends no
	// transactions for the 529 side)
	const out = insertTxn(db, 'l-out', 1, -50_000, '2026-06-10', 'TRANSFER_OUT');
	runTransferDetection(db);
	const itemId = db.prepare('SELECT id FROM review_items').pluck().get() as number;

	approveLoneLeg(db, itemId, true);

	expect(flags(db, out)).toEqual({ is_transfer: 1, is_saved: 1, transfer_peer_id: null });
	expect(db.prepare('SELECT status FROM review_items').pluck().get()).toBe('approved');
	// approved leg stays settled on the next detection run
	runTransferDetection(db);
	expect(db.prepare('SELECT COUNT(*) FROM review_items').pluck().get()).toBe(1);

	// "Transfer only" variant: excluded but not saved
	const db2 = makeDb();
	const out2 = insertTxn(db2, 'm-out', 1, -20_000, '2026-06-10', 'TRANSFER_OUT');
	runTransferDetection(db2);
	approveLoneLeg(db2, db2.prepare('SELECT id FROM review_items').pluck().get() as number, false);
	expect(flags(db2, out2)).toEqual({ is_transfer: 1, is_saved: 0, transfer_peer_id: null });
});

test('a rejected item can be reopened and then judged normally', () => {
	const db = makeDb();
	const out = insertTxn(db, 'u-out', 1, -50_000, '2026-06-10', 'TRANSFER_OUT');
	runTransferDetection(db);
	const itemId = db.prepare('SELECT id FROM review_items').pluck().get() as number;
	rejectReviewItem(db, itemId);

	reopenReviewItem(db, itemId);

	// back in the queue, still excluded from auto-detection, no duplicate item
	expect(db.prepare('SELECT status FROM review_items WHERE id = ?').pluck().get(itemId)).toBe('open');
	runTransferDetection(db);
	expect(db.prepare('SELECT COUNT(*) FROM review_items').pluck().get()).toBe(1);
	expect(flags(db, out).is_transfer).toBe(0);

	// and the reopened item accepts a normal verdict
	approveLoneLeg(db, itemId, true);
	expect(flags(db, out)).toEqual({ is_transfer: 1, is_saved: 1, transfer_peer_id: null });

	// reopening a non-rejected item is refused
	expect(() => reopenReviewItem(db, itemId)).toThrow();
});

test('a rejected lone leg never auto-pairs, even when a partner appears later', () => {
	const db = makeDb();
	// Plaid flags a transfer-looking out-leg with no partner yet
	const out = insertTxn(db, 'r-out', 1, -30_000, '2026-06-10', 'TRANSFER_OUT');
	runTransferDetection(db);
	const itemId = db.prepare('SELECT id FROM review_items').pluck().get() as number;
	rejectReviewItem(db, itemId);

	// next sync brings a matching partner — the owner already judged this leg
	const inn = insertTxn(db, 'r-in', 2, 30_000, '2026-06-11');
	runTransferDetection(db);

	expect(flags(db, out).is_transfer).toBe(0);
	expect(flags(db, inn).is_transfer).toBe(0);
	expect(db.prepare('SELECT COUNT(*) FROM review_items').pluck().get()).toBe(1);
});
