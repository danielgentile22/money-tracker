import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import { categoriesMonth, monthCursor } from './categories-page';
import { addGroup } from './groups';

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
function txn(db: Database.Database, category: string | null, date: string, cents: number) {
	db.prepare(
		`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, merchant, amount_cents, category_id)
		 VALUES (1, ?, ?, 'FX', 'fx', ?, (SELECT id FROM categories WHERE name = ?))`
	).run(`cp-${++seq}`, date, cents, category);
}
const spend = (db: Database.Database, category: string | null, date: string, cents: number) =>
	txn(db, category, date, -cents);

// ---------- Month cursor: the page's whole state, carried by the URL ----------

test('a valid ?month is the cursor; anything else falls back to the current month', () => {
	expect(monthCursor('2026-03', TODAY)).toBe('2026-03');
	expect(monthCursor(null, TODAY)).toBe('2026-07');
	expect(monthCursor('', TODAY)).toBe('2026-07');
	expect(monthCursor('2026-13', TODAY)).toBe('2026-07');
	expect(monthCursor('garbage', TODAY)).toBe('2026-07');
	expect(monthCursor('2026-03-15', TODAY)).toBe('2026-07');
});

// ---------- Ranked list: the list itself answers "which Categories cost the most" ----------

test('lines and groups are ranked by actual spending, biggest first; zero-spend rows stay visible', () => {
	const db = makeDb();
	spend(db, 'Coffee', '2026-07-03', 10_00);
	spend(db, 'Groceries', '2026-07-05', 100_00);
	spend(db, 'Dining', '2026-07-08', 50_00);
	spend(db, 'Travel', '2026-07-10', 200_00);

	const page = categoriesMonth(db, '2026-07');
	const [g1, g2] = page.snapshot.groups;
	expect(g1.name).toBe('Travel & Lifestyle'); // $200 beats Food & Dining's $160
	expect(g2.name).toBe('Food & Dining');
	expect(g2.lines.map((l) => l.name)).toEqual(['Groceries', 'Dining', 'Coffee']);
	// unspent groups still render (they hold the budget-editing rows)
	expect(page.snapshot.groups.map((g) => g.name)).toContain('Housing');
});

test('uncategorized spending is visible, scoped to the cursor month', () => {
	const db = makeDb();
	spend(db, null, '2026-07-04', 42_00);
	spend(db, null, '2026-06-04', 99_00); // other month — must not leak in

	expect(categoriesMonth(db, '2026-07').uncategorized_cents).toBe(42_00);
	expect(categoriesMonth(db, '2026-06').uncategorized_cents).toBe(99_00);
	expect(categoriesMonth(db, '2026-05').uncategorized_cents).toBe(0);
});

// ---------- Management data (slice 5): the page is the whole manager ----------

test('a Group with no Categories still renders — it must be manageable (rename, delete, reorder)', () => {
	const db = makeDb();
	addGroup(db, 'Brand New');
	const page = categoriesMonth(db, '2026-07');
	const g = page.snapshot.groups.find((g) => g.name === 'Brand New');
	expect(g).toBeDefined();
	expect(g!.lines).toEqual([]);
	expect(g!.budget_cents).toBe(0);
});

test("a Group left holding only 'Transfer' still renders — otherwise it becomes unmanageable forever", () => {
	const db = makeDb();
	// budgetMonth renders no line for Transfer, so its Group would vanish
	const transferGroup = db
		.prepare(
			`SELECT g.id, g.name FROM category_groups g
			 JOIN categories c ON c.group_id = g.id WHERE c.name = 'Transfer'`
		)
		.get() as { id: number; name: string };
	const other = db.prepare("SELECT id FROM category_groups WHERE name = 'Other'").pluck().get();
	db.prepare('UPDATE categories SET group_id = ? WHERE group_id = ? AND name != ?').run(
		other,
		transferGroup.id,
		'Transfer'
	);
	const page = categoriesMonth(db, '2026-07');
	expect(page.snapshot.groups.map((g) => g.group_id)).toContain(transferGroup.id);
});

test('per-Category usage counts ride along, so Delete can say what the re-home moves', () => {
	const db = makeDb();
	spend(db, 'Coffee', '2026-07-03', 10_00);
	spend(db, 'Coffee', '2026-06-03', 5_00); // usage counts all history, not the cursor month
	const page = categoriesMonth(db, '2026-07');
	const coffee = page.snapshot.groups.flatMap((g) => g.lines).find((l) => l.name === 'Coffee')!;
	expect(page.usage[coffee.category_id].txns).toBe(2);
	// every rendered line has an entry (seed data may give it mappings, so no exact zeros)
	const travel = page.snapshot.groups.flatMap((g) => g.lines).find((l) => l.name === 'Travel')!;
	expect(page.usage[travel.category_id].txns).toBe(0);
	expect(page.usage[travel.category_id].budgets).toBe(0);
});

test('the Sankey flow covers exactly the cursor month, so it agrees with the list', () => {
	const db = makeDb();
	txn(db, 'Income', '2026-07-01', 500_00);
	spend(db, 'Groceries', '2026-07-05', 100_00);
	spend(db, 'Groceries', '2026-06-30', 77_00); // day before the month — excluded
	spend(db, 'Groceries', '2026-08-01', 88_00); // day after — excluded

	const page = categoriesMonth(db, '2026-07');
	expect(page.flow.income_cents).toBe(500_00);
	expect(page.flow.expenses_cents).toBe(100_00);
	expect(page.flow.income_cents).toBe(page.snapshot.income.actual_cents);
});
