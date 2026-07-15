import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import {
	mergeCategory,
	deleteCategory,
	setMapping,
	addCategory,
	renameCategory
} from './categories';

function makeDb() {
	const db = new Database(':memory:');
	migrate(db);
	db.prepare("INSERT INTO connections (institution_name, plaid_item_id) VALUES ('B', 'i')").run();
	db.prepare(
		"INSERT INTO accounts (connection_id, plaid_account_id, name, type) VALUES (1, 'a', 'Checking', 'depository')"
	).run();
	return db;
}

const cat = (db: Database.Database, name: string) =>
	db.prepare('SELECT id FROM categories WHERE name = ?').pluck().get(name) as number;

function insertTxn(db: Database.Database, pid: string, categoryName: string, source: string) {
	return db
		.prepare(
			`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, merchant, amount_cents, category_id, category_source, plaid_category_primary)
			 VALUES (1, ?, '2026-06-01', 'X', 'X', -100, ?, ?, 'FOOD_AND_DRINK') RETURNING id`
		)
		.pluck()
		.get(pid, cat(db, categoryName), source) as number;
}

test('merge re-points transactions, rules, and mappings; no orphans remain', () => {
	const db = makeDb();
	const coffee = cat(db, 'Coffee');
	const dining = cat(db, 'Dining');
	insertTxn(db, 't1', 'Coffee', 'plaid');
	db.prepare('INSERT INTO rules (merchant, category_id) VALUES (?, ?)').run('X', coffee);

	mergeCategory(db, coffee, dining);

	expect(db.prepare('SELECT COUNT(*) FROM categories WHERE id = ?').pluck().get(coffee)).toBe(0);
	expect(db.prepare('SELECT category_id FROM transactions').pluck().get()).toBe(dining);
	expect(db.prepare('SELECT category_id FROM rules').pluck().get()).toBe(dining);
	expect(
		db.prepare('SELECT COUNT(*) FROM plaid_category_map WHERE category_id = ?').pluck().get(coffee)
	).toBe(0);
});

test('delete with a destination re-homes txns, rules, mappings, and budgets, then removes', () => {
	const db = makeDb();
	const coffee = cat(db, 'Coffee');
	const dining = cat(db, 'Dining');
	insertTxn(db, 't1', 'Coffee', 'plaid');
	db.prepare('INSERT INTO rules (merchant, category_id) VALUES (?, ?)').run('X', coffee);
	db.prepare('INSERT INTO budgets (category_id, month, amount_cents) VALUES (?, ?, ?)').run(coffee, '2026-06', 5_000);

	deleteCategory(db, coffee, dining);

	expect(db.prepare('SELECT COUNT(*) FROM categories WHERE id = ?').pluck().get(coffee)).toBe(0);
	expect(db.prepare('SELECT category_id FROM transactions').pluck().get()).toBe(dining);
	expect(db.prepare('SELECT category_id FROM rules').pluck().get()).toBe(dining);
	expect(
		db.prepare('SELECT COUNT(*) FROM plaid_category_map WHERE category_id = ?').pluck().get(coffee)
	).toBe(0);
	expect(
		db.prepare('SELECT amount_cents FROM budgets WHERE category_id = ? AND month = ?').pluck().get(dining, '2026-06')
	).toBe(5_000);
});

test('budgets alone make a Category in-use; colliding months add up; self-destination refuses', () => {
	const db = makeDb();
	const coffee = cat(db, 'Coffee');
	const dining = cat(db, 'Dining');
	db.prepare('INSERT INTO budgets (category_id, month, amount_cents) VALUES (?, ?, ?)').run(coffee, '2026-06', 5_000);
	db.prepare('INSERT INTO budgets (category_id, month, amount_cents) VALUES (?, ?, ?)').run(dining, '2026-06', 40_000);

	expect(() => deleteCategory(db, coffee)).toThrow(/destination/); // budget rows are history too
	expect(() => deleteCategory(db, coffee, coffee)).toThrow(/itself/);

	deleteCategory(db, coffee, dining);
	expect(
		db.prepare('SELECT amount_cents FROM budgets WHERE category_id = ? AND month = ?').pluck().get(dining, '2026-06')
	).toBe(45_000);
});

test('in-use delete without a destination refuses; unused deletes straight; Other is protected', () => {
	const db = makeDb();
	insertTxn(db, 't1', 'Coffee', 'plaid');
	expect(() => deleteCategory(db, cat(db, 'Coffee'))).toThrow(/destination/);
	expect(() => deleteCategory(db, cat(db, 'Other'))).toThrow(/machinery/);
	const scratch = addCategory(db, 'Scratch');
	deleteCategory(db, scratch);
	expect(db.prepare("SELECT COUNT(*) FROM categories WHERE name = 'Scratch'").pluck().get()).toBe(0);
});

test('Income, Transfer, and Other reject merge and delete', () => {
	const db = makeDb();
	for (const name of ['Income', 'Transfer', 'Other']) {
		expect(() => mergeCategory(db, cat(db, name), cat(db, 'Dining'))).toThrow(/machinery/);
		expect(() => deleteCategory(db, cat(db, name))).toThrow(/machinery/);
	}
});

test('merge/delete into an analytics anchor is rejected; Other stays a valid sink', () => {
	const db = makeDb();
	const coffee = cat(db, 'Coffee');
	insertTxn(db, 't1', 'Coffee', 'plaid');
	// merging spending into Transfer/Income would pollute the anchor — refused
	expect(() => mergeCategory(db, coffee, cat(db, 'Transfer'))).toThrow(/anchors analytics/);
	expect(() => mergeCategory(db, coffee, cat(db, 'Income'))).toThrow(/anchors analytics/);
	expect(() => mergeCategory(db, coffee, 999_999)).toThrow(/does not exist/);
	// Other is the fallback sink — re-homing into it is fine
	deleteCategory(db, coffee, cat(db, 'Other'));
	expect(db.prepare('SELECT COUNT(*) FROM categories WHERE id = ?').pluck().get(coffee)).toBe(0);
});

test('protected Categories reject rename — the machinery is keyed on their names — but emoji-only saves pass', () => {
	const db = makeDb();
	for (const name of ['Income', 'Transfer', 'Other']) {
		expect(() => renameCategory(db, cat(db, name), 'Misc')).toThrow(/machinery/);
		renameCategory(db, cat(db, name), name); // unchanged name = emoji-only save, fine
	}
	renameCategory(db, cat(db, 'Coffee'), 'Café'); // ordinary Categories rename freely
	expect(db.prepare("SELECT COUNT(*) FROM categories WHERE name = 'Café'").pluck().get()).toBe(1);
});

test('mapping change re-categorizes only plaid-source Transactions', () => {
	const db = makeDb();
	const plaidRow = insertTxn(db, 't-plaid', 'Dining', 'plaid');
	const correctedRow = insertTxn(db, 't-corr', 'Dining', 'correction');
	db.prepare('INSERT INTO rules (merchant, category_id) VALUES (?, ?)').run('Y', cat(db, 'Kids'));
	const ruleRow = insertTxn(db, 't-rule', 'Kids', 'rule');
	db.prepare("UPDATE transactions SET merchant = 'Y' WHERE id = ?").run(ruleRow);

	setMapping(db, 'FOOD_AND_DRINK', cat(db, 'Groceries'));

	const state = (id: number) =>
		db.prepare('SELECT category_id, category_source FROM transactions WHERE id = ?').get(id) as {
			category_id: number;
			category_source: string;
		};
	expect(state(plaidRow)).toEqual({ category_id: cat(db, 'Groceries'), category_source: 'plaid' });
	expect(state(correctedRow).category_id).toBe(cat(db, 'Dining')); // correction untouched
	expect(state(ruleRow)).toEqual({ category_id: cat(db, 'Kids'), category_source: 'rule' }); // rule beats mapping
});
