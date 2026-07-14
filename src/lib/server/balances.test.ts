import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import { recordSnapshots, reconstructHistory, balanceSeries, netWorthSeries } from './balances';

function makeDb() {
	const db = new Database(':memory:');
	migrate(db);
	db.prepare("INSERT INTO connections (institution_name, plaid_item_id) VALUES ('B', 'i')").run();
	return db;
}

function addAccount(
	db: Database.Database,
	pid: string,
	type: string,
	balanceCents: number | null
): number {
	return db
		.prepare(
			`INSERT INTO accounts (connection_id, plaid_account_id, name, type, current_balance_cents)
			 VALUES (1, ?, ?, ?, ?) RETURNING id`
		)
		.pluck()
		.get(pid, pid, type, balanceCents) as number;
}

function addTxn(db: Database.Database, accountId: number, date: string, cents: number): void {
	db.prepare(
		`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, amount_cents)
		 VALUES (?, ?, ?, 'T', ?)`
	).run(accountId, `t-${accountId}-${date}-${cents}`, date, cents);
}

test('one Snapshot per Account per sync; same-day re-sync updates, no duplicate', () => {
	const db = makeDb();
	const checking = addAccount(db, 'a1', 'depository', 100_000);
	const invest = addAccount(db, 'a2', 'investment', 555_000);

	recordSnapshots(db, '2026-07-04');
	db.prepare('UPDATE accounts SET current_balance_cents = 90_000 WHERE id = ?').run(checking);
	recordSnapshots(db, '2026-07-04');

	expect(balanceSeries(db, checking)).toEqual([
		{ date: '2026-07-04', balance_cents: 90_000, estimated: 0 }
	]);
	expect(balanceSeries(db, invest)).toEqual([
		{ date: '2026-07-04', balance_cents: 555_000, estimated: 0 }
	]);
});

test('backward reconstruction matches the hand-computed fixture', () => {
	const db = makeDb();
	// day 1 = 2026-07-04, balance $1,000.00
	// txns: +$200.00 on 07-02 (income), -$50.00 on 07-03 (spend)
	// so: end of 07-03 = $1,000; 07-02 = $1,050; 07-01 (eve of first txn) = $850
	const acct = addAccount(db, 'a1', 'depository', 100_000);
	addTxn(db, acct, '2026-07-02', 20_000);
	addTxn(db, acct, '2026-07-03', -5_000);
	recordSnapshots(db, '2026-07-04');

	reconstructHistory(db);

	expect(balanceSeries(db, acct)).toEqual([
		{ date: '2026-07-01', balance_cents: 85_000, estimated: 1 },
		{ date: '2026-07-02', balance_cents: 105_000, estimated: 1 },
		{ date: '2026-07-03', balance_cents: 100_000, estimated: 1 },
		{ date: '2026-07-04', balance_cents: 100_000, estimated: 0 }
	]);
});

test('reconstruction is idempotent and re-anchors as history deepens', () => {
	const db = makeDb();
	const acct = addAccount(db, 'a1', 'depository', 100_000);
	addTxn(db, acct, '2026-07-03', -5_000);
	recordSnapshots(db, '2026-07-04');
	reconstructHistory(db);
	// a later sync backfills an older transaction
	addTxn(db, acct, '2026-07-01', 20_000);
	reconstructHistory(db);

	expect(balanceSeries(db, acct)).toEqual([
		{ date: '2026-06-30', balance_cents: 85_000, estimated: 1 },
		{ date: '2026-07-01', balance_cents: 105_000, estimated: 1 },
		{ date: '2026-07-02', balance_cents: 105_000, estimated: 1 },
		{ date: '2026-07-03', balance_cents: 100_000, estimated: 1 },
		{ date: '2026-07-04', balance_cents: 100_000, estimated: 0 }
	]);
});

test('investment Accounts get Snapshots but never reconstruction', () => {
	const db = makeDb();
	const invest = addAccount(db, 'a1', 'investment', 555_000);
	addTxn(db, invest, '2026-07-01', -100_000); // a buy inside the account
	recordSnapshots(db, '2026-07-04');

	reconstructHistory(db);

	expect(balanceSeries(db, invest)).toEqual([
		{ date: '2026-07-04', balance_cents: 555_000, estimated: 0 }
	]);
});

test('pending Transactions are ignored by reconstruction', () => {
	const db = makeDb();
	const acct = addAccount(db, 'a1', 'depository', 100_000);
	addTxn(db, acct, '2026-07-03', -5_000);
	db.prepare(
		`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, amount_cents, pending)
		 VALUES (?, 'pend', '2026-07-03', 'P', -99_999, 1)`
	).run(acct);
	recordSnapshots(db, '2026-07-04');

	reconstructHistory(db);

	expect(balanceSeries(db, acct).find((p) => p.date === '2026-07-02')?.balance_cents).toBe(
		105_000
	);
});

test('net worth sums Accounts per date: forward-fill, negative liabilities, estimated union', () => {
	const db = makeDb();
	const checking = addAccount(db, 'a1', 'depository', null);
	const card = addAccount(db, 'a2', 'credit', null);
	const plan529 = addAccount(db, 'a3', 'investment', null);
	const snap = db.prepare(
		'INSERT INTO snapshots (account_id, date, balance_cents, estimated) VALUES (?, ?, ?, ?)'
	);
	snap.run(checking, '2026-07-01', 100_000, 1); // reconstructed pre-day-1
	snap.run(checking, '2026-07-02', 120_000, 0);
	snap.run(card, '2026-07-02', -50_000, 0); // liability stored negative (p1-13)
	snap.run(checking, '2026-07-03', 110_000, 0);
	snap.run(card, '2026-07-03', -40_000, 0);
	snap.run(plan529, '2026-07-03', 200_000, 0);
	snap.run(plan529, '2026-07-04', 210_000, 0); // others forward-filled today

	expect(netWorthSeries(db)).toEqual([
		{ date: '2026-07-01', balance_cents: 100_000, estimated: 1 },
		{ date: '2026-07-02', balance_cents: 70_000, estimated: 0 },
		{ date: '2026-07-03', balance_cents: 270_000, estimated: 0 },
		{ date: '2026-07-04', balance_cents: 280_000, estimated: 0 }
	]);
});

test('recordSnapshots skips inactive accounts (p9-00)', () => {
	const db = makeDb();
	const live = addAccount(db, 'a1', 'depository', 100_000);
	const dead = addAccount(db, 'a2', 'depository', 50_000);
	db.prepare('UPDATE accounts SET active = 0 WHERE id = ?').run(dead);

	recordSnapshots(db, '2026-07-04');

	expect(balanceSeries(db, live)).toHaveLength(1);
	expect(balanceSeries(db, dead)).toHaveLength(0);
});

test('recordSnapshots only snapshots the given connections (p9-09)', () => {
	const db = makeDb();
	db.prepare("INSERT INTO connections (institution_name, plaid_item_id) VALUES ('B2', 'i2')").run();
	const onConn1 = addAccount(db, 'a1', 'depository', 100_000); // connection 1
	const onConn2 = db
		.prepare(
			`INSERT INTO accounts (connection_id, plaid_account_id, name, type, current_balance_cents)
			 VALUES (2, 'a2', 'a2', 'depository', 50_000) RETURNING id`
		)
		.pluck()
		.get() as number;

	recordSnapshots(db, '2026-07-04', [1]); // only connection 1 synced this run

	expect(balanceSeries(db, onConn1)).toHaveLength(1);
	expect(balanceSeries(db, onConn2)).toHaveLength(0);
});

test('an inactive account stops feeding net worth after its final snapshot (p9-00)', () => {
	const db = makeDb();
	const live = addAccount(db, 'a1', 'depository', 100_000);
	const dead = addAccount(db, 'a2', 'depository', 40_000);
	recordSnapshots(db, '2026-07-01'); // day 1: both real

	// the dead account is dropped from Plaid; the live one syncs again on day 2
	db.prepare('UPDATE accounts SET active = 0 WHERE id = ?').run(dead);
	db.prepare('UPDATE accounts SET current_balance_cents = 110_000 WHERE id = ?').run(live);
	recordSnapshots(db, '2026-07-02'); // dead is skipped (inactive)

	expect(netWorthSeries(db)).toEqual([
		{ date: '2026-07-01', balance_cents: 140_000, estimated: 0 }, // both still count on day 1
		{ date: '2026-07-02', balance_cents: 110_000, estimated: 0 } // dead no longer carried forward
	]);
});
