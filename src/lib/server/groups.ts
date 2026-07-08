import type { Database } from 'better-sqlite3';

export type GroupedCategory = {
	id: number;
	name: string;
	emoji: string | null;
	sort_order: number;
	disabled: number;
};

export type Group = {
	id: number;
	name: string;
	emoji: string | null;
	sort_order: number;
	categories: GroupedCategory[];
};

/**
 * The taxonomy tree every picker renders: Groups in order, Categories in order
 * within each. Default hides disabled Categories (story 9); the filter trees
 * on /transactions and /reports pass includeDisabled so history stays filterable.
 */
export function groupedCategories(db: Database, opts: { includeDisabled?: boolean } = {}): Group[] {
	const groups = db
		.prepare('SELECT id, name, emoji, sort_order FROM category_groups ORDER BY sort_order, id')
		.all() as Omit<Group, 'categories'>[];
	const cats = db
		.prepare(
			`SELECT id, name, emoji, sort_order, disabled, group_id FROM categories
			 ${opts.includeDisabled ? '' : 'WHERE disabled = 0'}
			 ORDER BY sort_order, id`
		)
		.all() as (GroupedCategory & { group_id: number })[];
	return groups.map((g) => ({ ...g, categories: cats.filter((c) => c.group_id === g.id) }));
}

export function addGroup(db: Database, name: string): number {
	const n = name.trim();
	if (!n) throw new Error('name required');
	const next = (db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 FROM category_groups').pluck().get() as number);
	return db
		.prepare('INSERT INTO category_groups (name, sort_order) VALUES (?, ?) RETURNING id')
		.pluck()
		.get(n, next) as number;
}

export function renameGroup(db: Database, id: number, newName: string): void {
	const name = newName.trim();
	if (!name) throw new Error('name required');
	// budgetMonth splits income by the 'Income' Group name, and inline
	// mid-Correction Categories land in the Group named 'Other' — renaming
	// either silently breaks that machinery. Unchanged name = emoji-only save.
	const current = db.prepare('SELECT name FROM category_groups WHERE id = ?').pluck().get(id) as
		| string
		| undefined;
	if (current !== name && current && ['income', 'other'].includes(current.toLowerCase()))
		throw new Error(`the "${current}" Group cannot be renamed — the app's machinery depends on it`);
	db.prepare('UPDATE category_groups SET name = ? WHERE id = ?').run(name, id);
}

export function setGroupEmoji(db: Database, id: number, emoji: string | null): void {
	db.prepare('UPDATE category_groups SET emoji = ? WHERE id = ?').run(emoji?.trim() || null, id);
}

/** A Group deletes only when empty — Categories must be moved out first (story 4). */
export function deleteGroup(db: Database, id: number): void {
	const count = db
		.prepare('SELECT COUNT(*) FROM categories WHERE group_id = ?')
		.pluck()
		.get(id) as number;
	if (count > 0) throw new Error('Group still contains Categories — move them out first');
	db.prepare('DELETE FROM category_groups WHERE id = ?').run(id);
}

export function moveCategoryToGroup(db: Database, categoryId: number, groupId: number): void {
	const exists = db.prepare('SELECT 1 FROM category_groups WHERE id = ?').pluck().get(groupId);
	if (!exists) throw new Error('no such Group');
	const next = db
		.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 FROM categories WHERE group_id = ?')
		.pluck()
		.get(groupId) as number;
	db.prepare('UPDATE categories SET group_id = ?, sort_order = ? WHERE id = ?').run(
		groupId,
		next,
		categoryId
	);
}

// ponytail: reorder = swap with the neighbor, one click per step — no
// drag-and-drop, no bulk order payloads. Upgrade if the owner ever complains.
export function nudgeGroup(db: Database, id: number, dir: -1 | 1): void {
	nudge(db, 'category_groups', id, dir, '');
}

/** Reorder a Category within its Group. */
export function nudgeCategory(db: Database, id: number, dir: -1 | 1): void {
	const groupId = db.prepare('SELECT group_id FROM categories WHERE id = ?').pluck().get(id) as number;
	nudge(db, 'categories', id, dir, `AND group_id = ${groupId}`);
}

function nudge(db: Database, table: string, id: number, dir: -1 | 1, scope: string): void {
	const row = db.prepare(`SELECT sort_order FROM ${table} WHERE id = ?`).get(id) as
		| { sort_order: number }
		| undefined;
	if (!row) return;
	const neighbor = db
		.prepare(
			`SELECT id, sort_order FROM ${table}
			 WHERE ${dir === 1 ? 'sort_order > ?' : 'sort_order < ?'} ${scope}
			 ORDER BY sort_order ${dir === 1 ? 'ASC' : 'DESC'}, id ${dir === 1 ? 'ASC' : 'DESC'} LIMIT 1`
		)
		.get(row.sort_order) as { id: number; sort_order: number } | undefined;
	if (!neighbor) return;
	db.transaction(() => {
		db.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ?`).run(neighbor.sort_order, id);
		db.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ?`).run(row.sort_order, neighbor.id);
	})();
}
