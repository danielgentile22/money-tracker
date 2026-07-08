import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import { queryLedger, searchTransactions, toCsv, amountsFromUrl } from './ledger';

function makeDb() {
	const db = new Database(':memory:');
	migrate(db);
	db.prepare("INSERT INTO connections (institution_name, plaid_item_id) VALUES ('B', 'i')").run();
	const acct = db.prepare(
		'INSERT INTO accounts (connection_id, plaid_account_id, name, type) VALUES (1, ?, ?, ?)'
	);
	acct.run('a1', 'Checking', 'depository');
	acct.run('a2', 'Credit Card', 'credit');
	const coffee = db.prepare("SELECT id FROM categories WHERE name = 'Coffee'").pluck().get();
	const dining = db.prepare("SELECT id FROM categories WHERE name = 'Dining'").pluck().get();
	const ins = db.prepare(
		`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, merchant, amount_cents, category_id, is_investment_activity)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	);
	ins.run(1, 't1', '2026-05-01', 'BLUE BOTTLE', 'Blue Bottle', -650, coffee, 0);
	ins.run(1, 't2', '2026-06-01', 'JOES "PIZZA", INC', 'Joes "Pizza",\nInc', -6347, dining, 0);
	ins.run(2, 't3', '2026-06-15', 'BLUE BOTTLE', 'Blue Bottle', -725, coffee, 0);
	ins.run(1, 't4', '2026-06-20', 'BUY VTI', 'BUY VTI', -100_000, null, 1);
	return db;
}

test('FilterSet dimensions and page-local amount bounds compose', () => {
	const db = makeDb();
	const dining = db.prepare("SELECT id FROM categories WHERE name='Dining'").pluck().get() as number;
	const rows = queryLedger(
		db,
		{
			accounts: { include: [1] },
			categories: { include: [dining] },
			date: { from: '2026-05-15', to: '2026-06-30' }
		},
		{ minAmountCents: 5000, maxAmountCents: 10_000 }
	);
	expect(rows.map((r) => r.date)).toEqual(['2026-06-01']);
});

test('amountsFromUrl converts dollars to absolute cents', () => {
	const f = amountsFromUrl(new URL('http://x/transactions?min=5&max=99.99'));
	expect(f).toEqual({ minAmountCents: 500, maxAmountCents: 9999 });
});

test('investment activity never appears in ledger queries', () => {
	const rows = queryLedger(makeDb(), { date: { preset: 'all' } });
	expect(rows.find((r) => r.name === 'BUY VTI')).toBeUndefined();
});

test('search matches Merchant substring, exact amount, and Category name', () => {
	const db = makeDb();
	expect(searchTransactions(db, 'blue').map((r) => r.date)).toEqual(['2026-06-15', '2026-05-01']);
	expect(searchTransactions(db, '63.47').map((r) => r.date)).toEqual(['2026-06-01']);
	expect(searchTransactions(db, 'Coffee')).toHaveLength(2);
	expect(searchTransactions(db, 'nothing-matches')).toEqual([]);
});

test('CSV escapes commas, quotes, and newlines; amounts in dollars', () => {
	const db = makeDb();
	const csv = toCsv(queryLedger(db, { accounts: { include: [1] }, date: { preset: 'all' } }));
	const lines = csv.trimEnd().split('\n');
	expect(lines[0]).toBe('date,merchant,account,category,amount,pending,transfer,saved,unresolved');
	const joes = lines.find((l) => l.includes('Joes'));
	expect(joes).toContain('"Joes ""Pizza"",\nInc"'.split('\n')[0]); // opening of quoted field
	expect(csv).toContain('"Joes ""Pizza"",\nInc"');
	expect(csv).toContain('-63.47');
	expect(csv).toContain('-6.50');
});
