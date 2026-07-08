import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import { syncConnection } from './sync';
import type { PlaidSource, SourceAccount, SourceInvestmentTxn } from './sync';
import { runTransferDetection } from './transfers-db';
import { recordSnapshots, reconstructHistory, balanceSeries } from './balances';

const BROKERAGE_ACCOUNTS: SourceAccount[] = [
	{
		account_id: 'acc-brokerage',
		name: 'Brokerage',
		type: 'investment',
		subtype: 'brokerage',
		mask: '1111',
		current_balance_cents: 12_000_000,
		available_balance_cents: null
	},
	{
		account_id: 'acc-529',
		name: 'College 529',
		type: 'investment',
		subtype: '529',
		mask: '2222',
		current_balance_cents: 3_500_000,
		available_balance_cents: null
	}
];

const invTxn = (
	id: string,
	over: Partial<SourceInvestmentTxn> = {}
): SourceInvestmentTxn => ({
	investment_transaction_id: id,
	account_id: 'acc-brokerage',
	date: '2026-06-10',
	name: 'BUY VTI',
	amount_cents: -100_000,
	internal: true,
	...over
});

function investmentSource(
	invTxns: SourceInvestmentTxn[],
	log: { syncCalled: boolean } = { syncCalled: false }
): PlaidSource {
	return {
		accounts: async () => BROKERAGE_ACCOUNTS,
		transactionsSync: async () => {
			log.syncCalled = true;
			throw new Error('investment-only Connections must not call /transactions/sync');
		},
		investmentsTransactions: async () => invTxns
	};
}

function makeDb() {
	const db = new Database(':memory:');
	migrate(db);
	db.prepare(
		"INSERT INTO connections (institution_name, plaid_item_id) VALUES ('Brokerage', 'item-m')"
	).run();
	return db;
}

test('investment-only Connection syncs accounts + balances without /transactions/sync', async () => {
	const db = makeDb();
	const log = { syncCalled: false };

	const result = await syncConnection(db, investmentSource([], log), 1);

	expect(result.ok).toBe(true);
	expect(log.syncCalled).toBe(false);
	const balances = db
		.prepare('SELECT name, current_balance_cents FROM accounts ORDER BY name')
		.all();
	expect(balances).toEqual([
		{ name: 'Brokerage', current_balance_cents: 12_000_000 },
		{ name: 'College 529', current_balance_cents: 3_500_000 }
	]);
});

test('Snapshots record for investment Accounts; no reconstruction despite activity', async () => {
	const db = makeDb();
	await syncConnection(db, investmentSource([invTxn('inv-1')]), 1);
	recordSnapshots(db, '2026-07-04');
	reconstructHistory(db);

	const brokerage = db
		.prepare("SELECT id FROM accounts WHERE plaid_account_id = 'acc-brokerage'")
		.pluck()
		.get() as number;
	expect(balanceSeries(db, brokerage)).toEqual([
		{ date: '2026-07-04', balance_cents: 12_000_000, estimated: 0 }
	]);
});

test('buys/sells/dividends are stored but invisible and never pair as Transfers', async () => {
	const db = makeDb();
	await syncConnection(
		db,
		investmentSource([
			invTxn('inv-buy', { amount_cents: -100_000 }),
			invTxn('inv-div', { name: 'DIVIDEND VTI', amount_cents: 4_200 }),
			invTxn('inv-sell', { name: 'SELL VXUS', amount_cents: 100_000 })
		]),
		1
	);
	runTransferDetection(db);

	const rows = db
		.prepare(
			'SELECT is_investment_activity, is_transfer, unresolved FROM transactions'
		)
		.all() as { is_investment_activity: number; is_transfer: number; unresolved: number }[];
	expect(rows).toHaveLength(3);
	for (const r of rows) {
		expect(r.is_investment_activity).toBe(1);
		expect(r.is_transfer).toBe(0);
		expect(r.unresolved).toBe(0);
	}
});

test('investments-not-supported skips investments but still syncs cash accounts', async () => {
	const db = makeDb();
	const mixed: SourceAccount[] = [
		...BROKERAGE_ACCOUNTS,
		{
			account_id: 'acc-checking',
			name: 'Checking',
			type: 'depository',
			subtype: 'checking',
			mask: '0001',
			current_balance_cents: 100_000,
			available_balance_cents: 100_000
		}
	];
	const source: PlaidSource = {
		accounts: async () => mixed,
		transactionsSync: async () => ({
			added: [
				{
					transaction_id: 't-cash',
					pending_transaction_id: null,
					account_id: 'acc-checking',
					date: '2026-06-01',
					name: 'COFFEE',
					merchant_name: null,
					amount_cents: -450,
					pending: false,
					pfc_primary: null,
					pfc_detailed: null,
					pfc_confidence: null,
					payment_channel: null
				}
			],
			modified: [],
			removed: [],
			next_cursor: 'c-1',
			has_more: false
		}),
		investmentsTransactions: async () => {
			throw Object.assign(new Error('400'), {
				response: {
					data: { error_code: 'PRODUCTS_NOT_SUPPORTED', error_message: 'not supported' }
				}
			});
		}
	};

	const result = await syncConnection(db, source, 1);

	expect(result.ok).toBe(true);
	expect(db.prepare('SELECT COUNT(*) FROM transactions').pluck().get()).toBe(1);
	expect(
		db.prepare('SELECT health, sync_cursor FROM connections WHERE id = 1').get()
	).toEqual({ health: 'healthy', sync_cursor: 'c-1' });
});

test('a checking→investment contribution pairs as Transfer and is marked saved', async () => {
	const db = makeDb();
	// the cash side (a second Connection with a checking Account)
	db.prepare("INSERT INTO connections (institution_name, plaid_item_id) VALUES ('Bank', 'item-b')").run();
	db.prepare(
		"INSERT INTO accounts (connection_id, plaid_account_id, name, type, subtype) VALUES (2, 'acc-checking', 'Checking', 'depository', 'checking')"
	).run();
	db.prepare(
		`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, amount_cents)
		 VALUES ((SELECT id FROM accounts WHERE plaid_account_id = 'acc-checking'), 'cash-out', '2026-06-09', 'TRANSFER TO BROKERAGE', -50_000)`
	).run();

	await syncConnection(
		db,
		investmentSource([
			invTxn('inv-contrib', {
				account_id: 'acc-529',
				name: 'CONTRIBUTION',
				amount_cents: 50_000,
				internal: false
			})
		]),
		1
	);
	runTransferDetection(db);

	const contrib = db
		.prepare(
			"SELECT is_transfer, is_saved, is_investment_activity FROM transactions WHERE plaid_transaction_id = 'inv-contrib'"
		)
		.get() as { is_transfer: number; is_saved: number; is_investment_activity: number };
	expect(contrib).toEqual({ is_transfer: 1, is_saved: 1, is_investment_activity: 0 });
	const cashLeg = db
		.prepare("SELECT is_transfer FROM transactions WHERE plaid_transaction_id = 'cash-out'")
		.get() as { is_transfer: number };
	expect(cashLeg.is_transfer).toBe(1);
});
