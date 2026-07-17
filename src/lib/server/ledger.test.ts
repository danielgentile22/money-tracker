import { test, expect } from 'vitest';
import { makeDb as fixtureDb, insertTxn, categoryId } from '../../test/db';
import { queryLedger, searchTransactions, toCsv, amountsFromUrl } from './ledger';

function makeDb() {
	const db = fixtureDb({ accounts: [{ name: 'Checking' }, { name: 'Credit Card', type: 'credit' }] });
	const coffee = categoryId(db, 'Coffee');
	const dining = categoryId(db, 'Dining');
	insertTxn(db, { date: '2026-05-01', merchant: 'Blue Bottle', name: 'BLUE BOTTLE', amount_cents: -650, category_id: coffee });
	insertTxn(db, { date: '2026-06-01', merchant: 'Joes "Pizza",\nInc', name: 'JOES "PIZZA", INC', amount_cents: -6347, category_id: dining });
	insertTxn(db, { date: '2026-06-15', merchant: 'Blue Bottle', name: 'BLUE BOTTLE', amount_cents: -725, category_id: coffee, account_id: 2 });
	insertTxn(db, { date: '2026-06-20', merchant: 'BUY VTI', name: 'BUY VTI', amount_cents: -100_000, is_investment_activity: 1 });
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

test('search treats % and _ as literals, not LIKE wildcards', () => {
	const db = makeDb();
	insertTxn(db, { date: '2026-06-25', merchant: '100% Juice', name: '100% JUICE', amount_cents: -400 });
	expect(searchTransactions(db, '%').map((r) => r.merchant)).toEqual(['100% Juice']);
	expect(searchTransactions(db, '_')).toEqual([]);
	expect(searchTransactions(db, '100% J')).toHaveLength(1);
});

test('queryLedger tolerates non-integer limit/offset (user-controlled ?page)', () => {
	const db = makeDb();
	const rows = queryLedger(db, { date: { preset: 'all' } }, { limit: 2.5, offset: 0.5 });
	expect(rows.length).toBeGreaterThan(0);
	// ?page=Infinity / NaN / oversized pages must not reach the binder as
	// non-safe-integers (SQLITE_MISMATCH → 500); they fall back instead of throwing
	expect(() => queryLedger(db, { date: { preset: 'all' } }, { offset: Infinity })).not.toThrow();
	expect(() => queryLedger(db, { date: { preset: 'all' } }, { limit: NaN, offset: 2 ** 60 })).not.toThrow();
});

test('CSV guards spreadsheet formula injection in text fields', () => {
	const db = makeDb();
	insertTxn(db, { date: '2026-06-26', merchant: '=SUM(A1:A9)', name: 'EVIL', amount_cents: -100 });
	const csv = toCsv(queryLedger(db, { date: { preset: 'all' } }));
	expect(csv).toContain("'=SUM(A1:A9)");
	expect(csv).not.toMatch(/^=|,=/m);
	// numeric amount column keeps its bare minus sign
	expect(csv).toContain(',-1.00,');
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
