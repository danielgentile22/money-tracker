import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import {
	parseFilters,
	serializeFilters,
	resolveDateRange,
	compileFilters,
	type FilterSet
} from './filters';

const TODAY = '2026-07-04';

function makeDb() {
	const db = new Database(':memory:');
	migrate(db);
	db.prepare("INSERT INTO connections (institution_name, plaid_item_id) VALUES ('B', 'i')").run();
	const acct = db.prepare(
		'INSERT INTO accounts (connection_id, plaid_account_id, name, type, subtype) VALUES (1, ?, ?, ?, ?)'
	);
	acct.run('a-checking', 'Checking', 'depository', 'checking');
	acct.run('a-card', 'Credit Card', 'credit', 'credit card');
	return db;
}

type Fixture = {
	date?: string;
	amount_cents?: number;
	account_id?: number;
	merchant?: string | null;
	name?: string;
	category?: string;
	is_transfer?: number;
	is_investment_activity?: number;
	tags?: string[];
};

let seq = 0;
function insert(db: Database.Database, rows: Fixture[]): number[] {
	const stmt = db.prepare(
		`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, merchant, amount_cents,
		   category_id, is_transfer, is_investment_activity)
		 VALUES (?, ?, ?, ?, ?, ?, (SELECT id FROM categories WHERE name = ?), ?, ?) RETURNING id`
	);
	const ids: number[] = [];
	for (const r of rows) {
		const id = stmt
			.pluck()
			.get(
				r.account_id ?? 1,
				`fx-${++seq}`,
				r.date ?? '2026-06-15',
				r.name ?? 'FIXTURE',
				r.merchant === undefined ? 'FIXTURE' : r.merchant,
				r.amount_cents ?? -1000,
				r.category ?? null,
				r.is_transfer ?? 0,
				r.is_investment_activity ?? 0
			) as number;
		for (const tag of r.tags ?? []) {
			const tagId = db
				.prepare('INSERT INTO tags (name) VALUES (?) ON CONFLICT (name) DO UPDATE SET name = name RETURNING id')
				.pluck()
				.get(tag) as number;
			db.prepare('INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)').run(id, tagId);
		}
		ids.push(id);
	}
	return ids;
}

function matching(db: Database.Database, f: FilterSet): number[] {
	const { clauses, params } = compileFilters(f, TODAY);
	return db
		.prepare(`SELECT t.id FROM transactions t WHERE ${clauses.join(' AND ')} ORDER BY t.id`)
		.pluck()
		.all(...params) as number[];
}

const cat = (db: Database.Database, name: string) =>
	db.prepare('SELECT id FROM categories WHERE name = ?').pluck().get(name) as number;
const group = (db: Database.Database, name: string) =>
	db.prepare('SELECT id FROM category_groups WHERE name = ?').pluck().get(name) as number;
const tag = (db: Database.Database, name: string) =>
	db.prepare('SELECT id FROM tags WHERE name = ?').pluck().get(name) as number;

// --- parse / serialize ---

test('URL → FilterSet → URL round-trips canonically', () => {
	const q = 'categories=2,1&xtags=5&merchants=Blue%20Bottle&merchants=Starbucks&date=ytd';
	const f = parseFilters(new URLSearchParams(q));
	expect(f).toEqual({
		categories: { include: [1, 2] },
		tags: { exclude: [5] },
		merchants: { include: ['Blue Bottle', 'Starbucks'] },
		date: { preset: 'ytd' }
	});
	const canonical = serializeFilters(f);
	expect(parseFilters(new URLSearchParams(canonical))).toEqual(f);
	expect(serializeFilters(parseFilters(new URLSearchParams(canonical)))).toBe(canonical);
});

test('serialize orders ids and merchants deterministically', () => {
	const a = serializeFilters({
		categories: { include: [3, 1, 2] },
		merchants: { include: ['b', 'a'] },
		date: { preset: 'all' }
	});
	const b = serializeFilters({
		categories: { include: [2, 1, 3] },
		merchants: { include: ['a', 'b'] },
		date: { preset: 'all' }
	});
	expect(a).toBe(b);
});

test('malformed params are dropped without error; unknown params ignored', () => {
	const f = parseFilters(
		new URLSearchParams('categories=abc,-1,0,2&accounts=&date=nonsense&bogus=1&page=3')
	);
	expect(f).toEqual({ categories: { include: [2] }, date: { preset: 'all' } });
});

test('custom from/to needs both valid dates; a reversed pair is swapped', () => {
	expect(parseFilters(new URLSearchParams('from=2026-01-01')).date).toEqual({ preset: 'all' });
	expect(parseFilters(new URLSearchParams('from=2026-01-01&to=garbage')).date).toEqual({
		preset: 'all'
	});
	expect(parseFilters(new URLSearchParams('from=2026-03-01&to=2026-01-01')).date).toEqual({
		from: '2026-01-01',
		to: '2026-03-01'
	});
});

test('a caller-supplied default preset applies only when the URL says nothing', () => {
	expect(parseFilters(new URLSearchParams(''), 'last-12-months').date).toEqual({
		preset: 'last-12-months'
	});
	expect(parseFilters(new URLSearchParams('date=all'), 'last-12-months').date).toEqual({
		preset: 'all'
	});
});

// --- preset resolution ---

test('presets resolve whole calendar months against local today', () => {
	expect(resolveDateRange({ preset: 'this-month' }, TODAY)).toEqual({
		from: '2026-07-01',
		to: '2026-07-31'
	});
	expect(resolveDateRange({ preset: 'last-3-months' }, TODAY)).toEqual({
		from: '2026-05-01',
		to: '2026-07-31'
	});
	expect(resolveDateRange({ preset: 'ytd' }, TODAY)).toEqual({
		from: '2026-01-01',
		to: '2026-07-31'
	});
	expect(resolveDateRange({ preset: 'last-12-months' }, TODAY)).toEqual({
		from: '2025-08-01',
		to: '2026-07-31'
	});
	expect(resolveDateRange({ preset: 'all' }, TODAY)).toEqual({ from: null, to: null });
});

test('preset resolution crosses year boundaries', () => {
	expect(resolveDateRange({ preset: 'last-3-months' }, '2026-01-15')).toEqual({
		from: '2025-11-01',
		to: '2026-01-31'
	});
	expect(resolveDateRange({ preset: 'last-12-months' }, '2026-02-01')).toEqual({
		from: '2025-03-01',
		to: '2026-02-28'
	});
	expect(resolveDateRange({ preset: 'this-month' }, '2024-02-10')).toEqual({
		from: '2024-02-01',
		to: '2024-02-29' // leap year
	});
});

// --- compile: every dimension, include / exclude / combined ---

test('category include and exclude select the right Transactions', () => {
	const db = makeDb();
	const [dining, coffee, uncat] = insert(db, [
		{ category: 'Dining' },
		{ category: 'Coffee' },
		{ category: undefined }
	]);
	expect(matching(db, { categories: { include: [cat(db, 'Dining')] }, date: { preset: 'all' } })).toEqual([dining]);
	// exclude keeps uncategorized rows
	expect(matching(db, { categories: { exclude: [cat(db, 'Dining')] }, date: { preset: 'all' } })).toEqual([coffee, uncat]);
});

test('group filters resolve through Categories; exclude keeps uncategorized', () => {
	const db = makeDb();
	const [dining, coffee, travel, uncat] = insert(db, [
		{ category: 'Dining' },
		{ category: 'Coffee' },
		{ category: 'Travel' },
		{ category: undefined }
	]);
	const food = group(db, 'Food & Dining');
	expect(matching(db, { groups: { include: [food] }, date: { preset: 'all' } })).toEqual([dining, coffee]);
	expect(matching(db, { groups: { exclude: [food] }, date: { preset: 'all' } })).toEqual([travel, uncat]);
});

test('account include/exclude', () => {
	const db = makeDb();
	const [checking, card] = insert(db, [{ account_id: 1 }, { account_id: 2 }]);
	expect(matching(db, { accounts: { include: [2] }, date: { preset: 'all' } })).toEqual([card]);
	expect(matching(db, { accounts: { exclude: [2] }, date: { preset: 'all' } })).toEqual([checking]);
});

test('tag include is has-any; tag exclude is has-none', () => {
	const db = makeDb();
	const [vacation, both, work, untagged] = insert(db, [
		{ tags: ['vacation'] },
		{ tags: ['vacation', 'work'] },
		{ tags: ['work'] },
		{ tags: [] }
	]);
	const v = tag(db, 'vacation');
	const w = tag(db, 'work');
	expect(matching(db, { tags: { include: [v] }, date: { preset: 'all' } })).toEqual([vacation, both]);
	expect(matching(db, { tags: { include: [v, w] }, date: { preset: 'all' } })).toEqual([vacation, both, work]);
	expect(matching(db, { tags: { exclude: [v] }, date: { preset: 'all' } })).toEqual([work, untagged]);
	expect(matching(db, { tags: { exclude: [v, w] }, date: { preset: 'all' } })).toEqual([untagged]);
});

test('merchant filters match case-insensitively with name fallback', () => {
	const db = makeDb();
	const [sbux, blue, raw] = insert(db, [
		{ merchant: 'Starbucks' },
		{ merchant: 'Blue Bottle' },
		{ merchant: null, name: 'SQ *CORNER CAFE' }
	]);
	expect(matching(db, { merchants: { include: ['starbucks'] }, date: { preset: 'all' } })).toEqual([sbux]);
	expect(matching(db, { merchants: { include: ['SQ *CORNER CAFE'] }, date: { preset: 'all' } })).toEqual([raw]);
	expect(matching(db, { merchants: { exclude: ['Starbucks'] }, date: { preset: 'all' } })).toEqual([blue, raw]);
});

test('include and exclude combine across dimensions', () => {
	const db = makeDb();
	// "Food & Dining group, excluding the vacation Tag, on the credit card"
	const [want, wrongAccount, tagged, wrongGroup] = insert(db, [
		{ category: 'Dining', account_id: 2 },
		{ category: 'Dining', account_id: 1 },
		{ category: 'Dining', account_id: 2, tags: ['vacation'] },
		{ category: 'Travel', account_id: 2 }
	]);
	expect(wrongAccount && tagged && wrongGroup).toBeTruthy();
	const rows = matching(db, {
		groups: { include: [group(db, 'Food & Dining')] },
		tags: { exclude: [tag(db, 'vacation')] },
		accounts: { include: [2] },
		date: { preset: 'all' }
	});
	expect(rows).toEqual([want]);
});

test('date presets and custom ranges bound the rows', () => {
	const db = makeDb();
	const [may, july, custom] = insert(db, [
		{ date: '2026-05-10' },
		{ date: '2026-07-02' },
		{ date: '2026-06-15' }
	]);
	expect(matching(db, { date: { preset: 'this-month' } })).toEqual([july]);
	expect(matching(db, { date: { preset: 'last-3-months' } })).toEqual([may, july, custom]);
	expect(matching(db, { date: { from: '2026-06-01', to: '2026-06-30' } })).toEqual([custom]);
});

test('investment activity is invisible to every compiled query', () => {
	const db = makeDb();
	const [visible] = insert(db, [{}, { is_investment_activity: 1 }]);
	expect(matching(db, { date: { preset: 'all' } })).toEqual([visible]);
});

test('disabled Categories still filter and aggregate historical rows', () => {
	const db = makeDb();
	const [row] = insert(db, [{ category: 'Dining' }]);
	db.prepare("UPDATE categories SET disabled = 1 WHERE name = 'Dining'").run();
	expect(matching(db, { categories: { include: [cat(db, 'Dining')] }, date: { preset: 'all' } })).toEqual([row]);
});
