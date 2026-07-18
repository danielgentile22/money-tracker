import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import { applyCorrection, applyBulkCorrection, updateRule, deleteRule } from './corrections';

function makeDb() {
	const db = new Database(':memory:');
	migrate(db);
	db.prepare("INSERT INTO connections (institution_name, plaid_item_id) VALUES ('B', 'i')").run();
	db.prepare(
		"INSERT INTO accounts (connection_id, plaid_account_id, name, type) VALUES (1, 'a', 'Checking', 'depository')"
	).run();
	return db;
}

function cat(db: Database.Database, name: string): number {
	return db.prepare('SELECT id FROM categories WHERE name = ?').pluck().get(name) as number;
}

function insertTxn(
	db: Database.Database,
	pid: string,
	merchant: string,
	source: 'plaid' | 'rule' | 'correction',
	categoryName = 'Dining'
): number {
	return db
		.prepare(
			`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, merchant, amount_cents, category_id, category_source, plaid_category_primary)
			 VALUES (1, ?, '2026-06-01', ?, ?, -450, ?, ?, 'FOOD_AND_DRINK') RETURNING id`
		)
		.pluck()
		.get(pid, merchant, merchant, cat(db, categoryName), source) as number;
}

function txnState(db: Database.Database, id: number) {
	return db
		.prepare(
			`SELECT c.name AS category, t.category_source AS source
			 FROM transactions t JOIN categories c ON c.id = t.category_id WHERE t.id = ?`
		)
		.get(id) as { category: string; source: string };
}

test('toggle ON mints a Rule and recategorizes past non-correction rows', () => {
	const db = makeDb();
	const target = insertTxn(db, 't-1', 'JOES PIZZA', 'plaid');
	const sibling = insertTxn(db, 't-2', 'JOES PIZZA', 'plaid');
	const corrected = insertTxn(db, 't-3', 'JOES PIZZA', 'correction', 'Gifts');

	applyCorrection(db, target, { categoryId: cat(db, 'Kids'), applyToFuture: true });

	expect(txnState(db, target)).toEqual({ category: 'Kids', source: 'correction' });
	expect(txnState(db, sibling)).toEqual({ category: 'Kids', source: 'rule' });
	expect(txnState(db, corrected)).toEqual({ category: 'Gifts', source: 'correction' });
	const rule = db.prepare('SELECT merchant, provenance FROM rules').get() as {
		merchant: string;
		provenance: string;
	};
	expect(rule.merchant).toBe('JOES PIZZA');
	expect(rule.provenance).toContain('JOES PIZZA');
});

test('correcting the same Merchant again updates the Rule instead of duplicating', () => {
	const db = makeDb();
	const t1 = insertTxn(db, 't-1', 'JOES PIZZA', 'plaid');
	applyCorrection(db, t1, { categoryId: cat(db, 'Kids'), applyToFuture: true });
	applyCorrection(db, t1, { categoryId: cat(db, 'Dining'), applyToFuture: true });

	const rules = db.prepare('SELECT category_id FROM rules').all() as { category_id: number }[];
	expect(rules).toEqual([{ category_id: cat(db, 'Dining') }]);
});

test('toggle OFF changes only that Transaction, no Rule minted', () => {
	const db = makeDb();
	const target = insertTxn(db, 't-1', 'AMAZON', 'plaid', 'Shopping');
	const sibling = insertTxn(db, 't-2', 'AMAZON', 'plaid', 'Shopping');

	applyCorrection(db, target, { categoryId: cat(db, 'Gifts'), applyToFuture: false });

	expect(txnState(db, target)).toEqual({ category: 'Gifts', source: 'correction' });
	expect(txnState(db, sibling)).toEqual({ category: 'Shopping', source: 'plaid' });
	expect(db.prepare('SELECT COUNT(*) FROM rules').pluck().get()).toBe(0);
});

test('a new Category can be created mid-Correction', () => {
	const db = makeDb();
	const target = insertTxn(db, 't-1', 'FLOWER SHOP', 'plaid');

	applyCorrection(db, target, { newCategoryName: 'Anniversaries', applyToFuture: false });

	expect(txnState(db, target).category).toBe('Anniversaries');
});

test('editing a Rule re-applies it; deleting reverts rows to the Plaid mapping', () => {
	const db = makeDb();
	const t1 = insertTxn(db, 't-1', 'JOES PIZZA', 'plaid');
	applyCorrection(db, t1, { categoryId: cat(db, 'Kids'), applyToFuture: true });
	const ruleId = db.prepare('SELECT id FROM rules').pluck().get() as number;

	updateRule(db, ruleId, {
		merchant: 'JOES PIZZA',
		minAmountCents: null,
		maxAmountCents: null,
		categoryId: cat(db, 'Entertainment')
	});
	// t-1 is correction-source: stays Kids. A fresh plaid row follows the edited Rule.
	expect(txnState(db, t1)).toEqual({ category: 'Kids', source: 'correction' });
	const t2 = insertTxn(db, 't-2', 'JOES PIZZA', 'plaid');
	updateRule(db, ruleId, {
		merchant: 'JOES PIZZA',
		minAmountCents: null,
		maxAmountCents: null,
		categoryId: cat(db, 'Entertainment')
	});
	expect(txnState(db, t2)).toEqual({ category: 'Entertainment', source: 'rule' });

	deleteRule(db, ruleId);
	// FOOD_AND_DRINK primary maps to Dining
	expect(txnState(db, t2)).toEqual({ category: 'Dining', source: 'plaid' });
	expect(txnState(db, t1)).toEqual({ category: 'Kids', source: 'correction' });
});

const txnTags = (db: Database.Database, id: number) =>
	db
		.prepare(
			'SELECT t.name FROM transaction_tags tt JOIN tags t ON t.id = tt.tag_id WHERE tt.transaction_id = ? ORDER BY t.name'
		)
		.pluck()
		.all(id) as string[];

test('a Correction with Tags attaches them and carries them into the minted Rule', () => {
	const db = makeDb();
	const tag = db.prepare("INSERT INTO tags (name) VALUES ('Tax deductible') RETURNING id").pluck().get() as number;
	const target = insertTxn(db, 't-1', 'BRIGHT HORIZONS', 'plaid');
	const sibling = insertTxn(db, 't-2', 'BRIGHT HORIZONS', 'plaid');

	applyCorrection(db, target, { categoryId: cat(db, 'Kids'), applyToFuture: true, tagIds: [tag] });

	expect(txnTags(db, target)).toEqual(['Tax deductible']);
	// the minted Rule carries the Tag and the sweep labeled the sibling too
	expect(db.prepare('SELECT COUNT(*) FROM rule_tags').pluck().get()).toBe(1);
	expect(txnTags(db, sibling)).toEqual(['Tax deductible']);
	expect(txnState(db, sibling)).toEqual({ category: 'Kids', source: 'rule' });
});

test('applying Rule Tags twice never duplicates (idempotent)', () => {
	const db = makeDb();
	const tag = db.prepare("INSERT INTO tags (name) VALUES ('Reimbursable') RETURNING id").pluck().get() as number;
	const target = insertTxn(db, 't-1', 'JOES PIZZA', 'plaid');
	applyCorrection(db, target, { categoryId: cat(db, 'Kids'), applyToFuture: true, tagIds: [tag] });
	const ruleId = db.prepare('SELECT id FROM rules').pluck().get() as number;

	updateRule(db, ruleId, {
		merchant: 'JOES PIZZA',
		minAmountCents: null,
		maxAmountCents: null,
		categoryId: cat(db, 'Kids'),
		tagIds: [tag]
	});

	expect(txnTags(db, target)).toEqual(['Reimbursable']);
	expect(db.prepare('SELECT COUNT(*) FROM transaction_tags').pluck().get()).toBe(1);
});

test('a tag-only Rule labels matches but leaves the Category to the Plaid map', () => {
	const db = makeDb();
	const tag = db.prepare("INSERT INTO tags (name) VALUES ('Vacation 2026') RETURNING id").pluck().get() as number;
	const t1 = insertTxn(db, 't-1', 'DELTA', 'plaid');
	db.prepare('INSERT INTO rules (merchant, category_id) VALUES (?, NULL)').run('DELTA');
	const ruleId = db.prepare('SELECT id FROM rules').pluck().get() as number;

	updateRule(db, ruleId, {
		merchant: 'DELTA',
		minAmountCents: null,
		maxAmountCents: null,
		categoryId: null,
		tagIds: [tag]
	});

	expect(txnTags(db, t1)).toEqual(['Vacation 2026']);
	// FOOD_AND_DRINK primary maps to Dining — the tag-only Rule didn't claim the rung
	expect(txnState(db, t1)).toEqual({ category: 'Dining', source: 'plaid' });

	expect(() =>
		updateRule(db, ruleId, {
			merchant: 'DELTA',
			minAmountCents: null,
			maxAmountCents: null,
			categoryId: null,
			tagIds: []
		})
	).toThrow(/Category, Tags, or both/);
});

test('Rule Tags attach across non-ASCII merchant casing, same as the Category', () => {
	const db = makeDb();
	const tag = db.prepare("INSERT INTO tags (name) VALUES ('Coffee') RETURNING id").pluck().get() as number;
	// stored txn merchant lower-cases 'É' → 'é'; SQLite lower() wouldn't, JS toLowerCase does
	const t1 = insertTxn(db, 't-1', 'Café Nero', 'plaid');
	db.prepare('INSERT INTO rules (merchant, category_id) VALUES (?, ?)').run('CAFÉ NERO', cat(db, 'Kids'));
	const ruleId = db.prepare('SELECT id FROM rules').pluck().get() as number;

	updateRule(db, ruleId, {
		merchant: 'CAFÉ NERO',
		minAmountCents: null,
		maxAmountCents: null,
		categoryId: cat(db, 'Kids'),
		tagIds: [tag]
	});

	// category applied AND the tag attached — not one without the other
	expect(txnState(db, t1)).toEqual({ category: 'Kids', source: 'rule' });
	expect(txnTags(db, t1)).toEqual(['Coffee']);
});

// --- bulk Correction (CONTEXT.md): always a one-off batch fix, never mints a Rule ---

test('bulk Correction recategorizes every selected Transaction, Rules untouched', () => {
	const db = makeDb();
	const a = insertTxn(db, 't-1', 'JOES PIZZA', 'plaid');
	const b = insertTxn(db, 't-2', 'AMAZON', 'plaid', 'Shopping');
	const untouched = insertTxn(db, 't-3', 'JOES PIZZA', 'plaid');

	applyBulkCorrection(db, [a, b], cat(db, 'Gifts'));

	expect(txnState(db, a)).toEqual({ category: 'Gifts', source: 'correction' });
	expect(txnState(db, b)).toEqual({ category: 'Gifts', source: 'correction' });
	expect(txnState(db, untouched)).toEqual({ category: 'Dining', source: 'plaid' });
	expect(db.prepare('SELECT COUNT(*) FROM rules').pluck().get()).toBe(0);
});

test('deleteRule reports whether a rule was actually deleted', () => {
	const db = makeDb();
	expect(deleteRule(db, 999)).toBe(false);
});
