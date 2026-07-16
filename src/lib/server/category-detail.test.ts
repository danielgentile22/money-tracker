import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import { categoryDetail } from './category-detail';
import { setBudget, setRolloverAnchor } from './budgets';

const TODAY = '2026-07-15';

function makeDb() {
	const db = new Database(':memory:');
	migrate(db);
	db.prepare("INSERT INTO connections (institution_name, plaid_item_id) VALUES ('B', 'i')").run();
	db.prepare(
		"INSERT INTO accounts (connection_id, plaid_account_id, name, type, subtype) VALUES (1, 'a1', 'Checking', 'depository', 'checking')"
	).run();
	return db;
}

let seq = 0;
function spend(db: Database.Database, category: string, date: string, cents: number, merchant = 'fx') {
	db.prepare(
		`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, merchant, amount_cents, category_id)
		 VALUES (1, ?, ?, ?, ?, ?, (SELECT id FROM categories WHERE name = ?))`
	).run(`cd-${++seq}`, date, merchant, merchant, -cents, category);
}

const catId = (db: Database.Database, name: string) =>
	db.prepare('SELECT id FROM categories WHERE name = ?').pluck().get(name) as number;

const detail = (db: Database.Database, name: string, month = '2026-07') =>
	categoryDetail(db, catId(db, name), month, TODAY);

// ---------- header facts ----------

test('header carries name, group, and the protected flag', () => {
	const db = makeDb();
	const groceries = detail(db, 'Groceries')!;
	expect(groceries.name).toBe('Groceries');
	expect(groceries.group_name).toBe('Food & Dining');
	expect(groceries.protected).toBe(false);

	// Other, Income, Transfer are load-bearing — no Delete affordance ever
	for (const name of ['Other', 'Income', 'Transfer'])
		expect(detail(db, name)!.protected).toBe(true);
});

test('unknown Category returns null', () => {
	expect(categoryDetail(makeDb(), 999, '2026-07', TODAY)).toBeNull();
});

// ---------- effective budget & rollover ----------

test('budget is the fill-forward effective amount; rollover carries prior surplus', () => {
	const db = makeDb();
	const groceries = catId(db, 'Groceries');
	setBudget(db, groceries, '2026-05', 50_000); // May budget inherited by June & July
	setRolloverAnchor(db, groceries, '2026-06');
	spend(db, 'Groceries', '2026-06-10', 30_000); // June: $200 surplus enters July

	const d = detail(db, 'Groceries')!;
	expect(d.budget_cents).toBe(50_000);
	expect(d.rollover_cents).toBe(20_000);

	// rollover off → null, not zero
	const dining = detail(db, 'Dining')!;
	expect(dining.budget_cents).toBe(0);
	expect(dining.rollover_cents).toBeNull();
});

// ---------- trend ----------

test('trend is 12 zero-filled months of spending ending at the cursor month', () => {
	const db = makeDb();
	spend(db, 'Groceries', '2026-07-03', 12_000);
	spend(db, 'Groceries', '2026-07-20', 8_000);
	spend(db, 'Groceries', '2026-05-10', 5_000);
	spend(db, 'Groceries', '2025-06-10', 99_000); // before the window — excluded
	spend(db, 'Dining', '2026-07-04', 7_000); // other Category — excluded

	const { trend } = detail(db, 'Groceries')!;
	expect(trend).toHaveLength(12);
	expect(trend[0]).toEqual({ month: '2025-08', spent_cents: 0 });
	expect(trend[11]).toEqual({ month: '2026-07', spent_cents: 20_000 });
	expect(trend[9]).toEqual({ month: '2026-05', spent_cents: 5_000 });
});

// Transfers never count; refunds net against spend (#24) so the trend matches
// the netted actual shown on the same panel.
test('trend excludes transfers and nets refunds against spend', () => {
	const db = makeDb();
	spend(db, 'Groceries', '2026-07-03', 10_000);
	db.prepare(
		`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, amount_cents, category_id, is_transfer)
		 VALUES (1, 'cd-tr', '2026-07-05', 'xfer', -50_000, (SELECT id FROM categories WHERE name = 'Groceries'), 1)`
	).run();
	db.prepare(
		`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, amount_cents, category_id)
		 VALUES (1, 'cd-rf', '2026-07-06', 'refund', 3_000, (SELECT id FROM categories WHERE name = 'Groceries'))`
	).run();
	expect(detail(db, 'Groceries')!.trend[11].spent_cents).toBe(7_000); // $100 − $30 refund
});

// ---------- recurring association ----------

function series(db: Database.Database, merchant: string, lastSeen: string) {
	db.prepare(
		`INSERT INTO recurring_series (merchant, cadence, typical_amount_cents, last_amount_cents, first_seen, last_seen)
		 VALUES (?, 'monthly', 1500, 1500, '2026-01-05', ?)`
	).run(merchant, lastSeen);
}

test("a Category's series are those whose Merchant's charges land dominantly in it", () => {
	const db = makeDb();
	series(db, 'instacart', '2026-07-05');
	series(db, 'doordash', '2026-07-05');
	// instacart charges are mostly Groceries (2 of 3); doordash is all Dining
	spend(db, 'Groceries', '2026-05-05', 1_500, 'instacart');
	spend(db, 'Groceries', '2026-06-05', 1_500, 'instacart');
	spend(db, 'Dining', '2026-07-05', 1_500, 'instacart');
	spend(db, 'Dining', '2026-07-05', 2_000, 'doordash');

	const groceries = detail(db, 'Groceries')!;
	expect(groceries.series.map((s) => s.merchant)).toEqual(['instacart']);
	expect(groceries.series[0].state).toBe('upcoming'); // derived from TODAY
	expect(detail(db, 'Dining')!.series.map((s) => s.merchant)).toEqual(['doordash']);
});

test('a long-silent series still shows, as ended', () => {
	const db = makeDb();
	series(db, 'instacart', '2026-03-05'); // ~4 monthly cycles missed by TODAY
	spend(db, 'Groceries', '2026-03-05', 1_500, 'instacart');
	expect(detail(db, 'Groceries')!.series[0].state).toBe('ended');
});

// #03: series merchants are stored lowercased, but real (Plaid) transaction
// merchants keep their case — the join must be case-insensitive.
test('mixed-case transaction merchant still associates its lowercased series', () => {
	const db = makeDb();
	series(db, 'netflix', '2026-07-05');
	spend(db, 'Subscriptions', '2026-05-05', 1_500, 'Netflix');
	spend(db, 'Subscriptions', '2026-06-05', 1_500, 'Netflix');
	expect(detail(db, 'Subscriptions')!.series.map((s) => s.merchant)).toEqual(['netflix']);
});
