import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import {
	groupedCategories,
	addGroup,
	renameGroup,
	deleteGroup,
	moveCategoryToGroup,
	nudgeGroup,
	nudgeCategory
} from './groups';

function makeDb() {
	const db = new Database(':memory:');
	migrate(db);
	return db;
}

const cat = (db: Database.Database, name: string) =>
	db.prepare('SELECT id FROM categories WHERE name = ?').pluck().get(name) as number;
const group = (db: Database.Database, name: string) =>
	db.prepare('SELECT id FROM category_groups WHERE name = ?').pluck().get(name) as number;

test('seed: 13 Groups, every Category homed per the session tracker', () => {
	const db = makeDb();
	const tree = groupedCategories(db);
	expect(tree.map((g) => g.name)).toEqual([
		'Income', 'Auto & Transport', 'Housing', 'Bills & Utilities', 'Food & Dining',
		'Travel & Lifestyle', 'Shopping', 'Children', 'Education', 'Gifts & Donations',
		'Health & Wellness', 'Financial', 'Other'
	]);
	const food = tree.find((g) => g.name === 'Food & Dining')!;
	expect(food.categories.map((c) => c.name)).toEqual(['Coffee', 'Groceries', 'Dining']);
	expect(tree.flatMap((g) => g.categories)).toHaveLength(26);
	expect(db.prepare('SELECT COUNT(*) FROM categories WHERE group_id IS NULL').pluck().get()).toBe(0);
});

test('Group CRUD; delete requires the Group be empty', () => {
	const db = makeDb();
	const id = addGroup(db, 'Hobbies');
	renameGroup(db, id, 'Fun');
	expect(group(db, 'Fun')).toBe(id);

	expect(() => deleteGroup(db, group(db, 'Food & Dining'))).toThrow(/move them out/);
	deleteGroup(db, id); // empty — fine
	expect(db.prepare('SELECT COUNT(*) FROM category_groups WHERE id = ?').pluck().get(id)).toBe(0);
});

test('moving a Category re-homes it and appends to the target order', () => {
	const db = makeDb();
	moveCategoryToGroup(db, cat(db, 'Coffee'), group(db, 'Shopping'));
	const tree = groupedCategories(db);
	const shopping = tree.find((g) => g.name === 'Shopping')!;
	expect(shopping.categories.map((c) => c.name)).toEqual(['Shopping', 'Cash', 'Coffee']);
	expect(() => moveCategoryToGroup(db, cat(db, 'Coffee'), 9999)).toThrow(/no such Group/);
});

test('nudge reorders Groups and Categories within a Group', () => {
	const db = makeDb();
	nudgeGroup(db, group(db, 'Food & Dining'), -1); // above Bills & Utilities
	expect(groupedCategories(db).map((g) => g.name).slice(3, 5)).toEqual([
		'Food & Dining',
		'Bills & Utilities'
	]);

	nudgeCategory(db, cat(db, 'Dining'), -1); // Coffee, Dining, Groceries
	const food = groupedCategories(db).find((g) => g.name === 'Food & Dining')!;
	expect(food.categories.map((c) => c.name)).toEqual(['Coffee', 'Dining', 'Groceries']);

	nudgeGroup(db, group(db, 'Income'), -1); // already first — no-op
	expect(groupedCategories(db)[0].name).toBe('Income');
});

test('groupedCategories hides disabled Categories unless asked', () => {
	const db = makeDb();
	db.prepare("UPDATE categories SET disabled = 1 WHERE name = 'Cash'").run();
	const names = (t: ReturnType<typeof groupedCategories>) =>
		t.flatMap((g) => g.categories.map((c) => c.name));
	expect(names(groupedCategories(db))).not.toContain('Cash');
	expect(names(groupedCategories(db, { includeDisabled: true }))).toContain('Cash');
});

test("the 'Income' and 'Other' Groups reject rename — budgetMonth and inline-Correction creation key on the names", () => {
	const db = makeDb();
	expect(() => renameGroup(db, group(db, 'Income'), 'Earnings')).toThrow(/machinery/);
	expect(() => renameGroup(db, group(db, 'Other'), 'Misc')).toThrow(/machinery/);
	renameGroup(db, group(db, 'Income'), 'Income'); // unchanged = emoji-only save, fine
	renameGroup(db, group(db, 'Shopping'), 'Retail'); // ordinary Groups rename freely
	expect(group(db, 'Retail')).toBeTruthy();
});
