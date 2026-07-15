import type { Database } from 'better-sqlite3';
import { recategorizeAll } from './categorize-db';
import { isProtectedCategory } from '../protected-categories';

export { isProtectedCategory };

function guardProtected(db: Database, id: number, verb: string): void {
	const name = db.prepare('SELECT name FROM categories WHERE id = ?').pluck().get(id) as string;
	if (name && isProtectedCategory(name))
		throw new Error(`"${name}" cannot be ${verb} — the app's machinery depends on it`);
}

export function renameCategory(db: Database, id: number, newName: string): void {
	const name = newName.trim();
	if (!name) throw new Error('name required');
	// protection is keyed on the name itself — renaming 'Other' would orphan
	// the categorization fallback. Unchanged name = emoji-only save, allowed.
	const current = db.prepare('SELECT name FROM categories WHERE id = ?').pluck().get(id) as
		| string
		| undefined;
	if (current !== name) guardProtected(db, id, 'renamed');
	db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name, id);
}

/** New Categories land in the chosen Group, or 'Other' when created inline mid-Correction. */
export function addCategory(db: Database, name: string, groupId?: number): number {
	const n = name.trim();
	if (!n) throw new Error('name required');
	const group =
		groupId ??
		(db.prepare("SELECT id FROM category_groups WHERE name = 'Other'").pluck().get() as number);
	const next = db
		.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 FROM categories WHERE group_id = ?')
		.pluck()
		.get(group) as number;
	return db
		.prepare(
			`INSERT INTO categories (name, group_id, sort_order) VALUES (?, ?, ?)
			 ON CONFLICT (name) DO UPDATE SET name = name RETURNING id`
		)
		.pluck()
		.get(n, group, next) as number;
}

export function setCategoryEmoji(db: Database, id: number, emoji: string | null): void {
	db.prepare('UPDATE categories SET emoji = ? WHERE id = ?').run(emoji?.trim() || null, id);
}

/** Re-point everything that references a Category (shared by merge and disable). */
function rehome(db: Database, fromId: number, intoId: number): void {
	db.prepare('UPDATE transactions SET category_id = ? WHERE category_id = ?').run(intoId, fromId);
	db.prepare('UPDATE rules SET category_id = ? WHERE category_id = ?').run(intoId, fromId);
	db.prepare('UPDATE plaid_category_map SET category_id = ? WHERE category_id = ?').run(intoId, fromId);
	// ponytail: colliding months add up; a true fill-forward merge of two budget
	// series is more math than a delete gesture deserves
	db.prepare(
		`INSERT INTO budgets (category_id, month, amount_cents)
		 SELECT ?, month, amount_cents FROM budgets WHERE category_id = ?
		 ON CONFLICT (category_id, month) DO UPDATE SET amount_cents = amount_cents + excluded.amount_cents`
	).run(intoId, fromId);
	db.prepare('DELETE FROM budgets WHERE category_id = ?').run(fromId);
}

/**
 * Guard a re-home destination: it must exist, and it can't be an analytics anchor
 * ('Income'/'Transfer') — merging spending there silently pollutes the anchor.
 * 'Other' is exempt: it's the taxonomy's fallback sink, the intended destination.
 */
function guardDestination(db: Database, intoId: number): void {
	const name = db.prepare('SELECT name FROM categories WHERE id = ?').pluck().get(intoId) as
		| string
		| undefined;
	if (!name) throw new Error('merge destination does not exist');
	if (isProtectedCategory(name) && name.toLowerCase() !== 'other')
		throw new Error(`"${name}" anchors analytics — it can't be a merge destination`);
}

/** Merge A into B: re-point Transactions, Rules, and mapping rows; A disappears. */
export function mergeCategory(db: Database, fromId: number, intoId: number): void {
	if (fromId === intoId) throw new Error('cannot merge a Category into itself');
	guardProtected(db, fromId, 'merged away');
	guardDestination(db, intoId);
	db.transaction(() => {
		rehome(db, fromId, intoId);
		db.prepare('DELETE FROM categories WHERE id = ?').run(fromId);
	})();
}

// Disable/enable retired with slice 5: delete-is-re-home replaced disable as
// the user-facing gesture, no disabled Categories existed, and the Settings
// hatch that flipped the flag is gone. The `disabled` column stays — pickers
// and budgetMonth still filter on it, and history renders fine either way.

export type CategoryUsage = { txns: number; rules: number; mappings: number; budgets: number };

/** Usage for every Category in one pass — four GROUP BY scans, not 4×N lookups. */
export function usageByCategory(db: Database): Record<number, CategoryUsage> {
	const out: Record<number, CategoryUsage> = {};
	const fill = (table: string, key: keyof CategoryUsage) => {
		const rows = db
			.prepare(
				`SELECT category_id, COUNT(*) AS n FROM ${table}
				 WHERE category_id IS NOT NULL GROUP BY category_id`
			)
			.all() as { category_id: number; n: number }[];
		for (const r of rows)
			(out[r.category_id] ??= { txns: 0, rules: 0, mappings: 0, budgets: 0 })[key] = r.n;
	};
	fill('transactions', 'txns');
	fill('rules', 'rules');
	fill('plaid_category_map', 'mappings');
	fill('budgets', 'budgets');
	return out;
}

export function usage(db: Database, id: number): CategoryUsage {
	return {
		txns: db.prepare('SELECT COUNT(*) FROM transactions WHERE category_id = ?').pluck().get(id) as number,
		rules: db.prepare('SELECT COUNT(*) FROM rules WHERE category_id = ?').pluck().get(id) as number,
		mappings: db.prepare('SELECT COUNT(*) FROM plaid_category_map WHERE category_id = ?').pluck().get(id) as number,
		budgets: db.prepare('SELECT COUNT(*) FROM budgets WHERE category_id = ?').pluck().get(id) as number
	};
}

/**
 * Delete is re-home (ADR-0008): an in-use Category needs a destination — its
 * Transactions, Rules, mappings, and budgets move there, then it's removed.
 * Unused Categories delete directly, no destination needed.
 */
export function deleteCategory(db: Database, id: number, destinationId?: number): void {
	guardProtected(db, id, 'deleted');
	const u = usage(db, id);
	if (u.txns + u.rules + u.mappings + u.budgets > 0) {
		if (!destinationId) throw new Error('Category is in use — pick a destination to re-home it');
		mergeCategory(db, id, destinationId);
		return;
	}
	db.prepare('DELETE FROM categories WHERE id = ?').run(id);
}

/** Re-map a Plaid key; only plaid-source Transactions re-categorize (ladder holds). */
export function setMapping(db: Database, plaidKey: string, categoryId: number): void {
	db.prepare('UPDATE plaid_category_map SET category_id = ? WHERE plaid_key = ?').run(
		categoryId,
		plaidKey
	);
	recategorizeAll(db, 'plaid');
}
