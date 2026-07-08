import type { Database } from 'better-sqlite3';

export type TagRow = { id: number; name: string; usage: number };

export function listTags(db: Database): TagRow[] {
	return db
		.prepare(
			`SELECT t.id, t.name, COUNT(tt.transaction_id) AS usage
			 FROM tags t LEFT JOIN transaction_tags tt ON tt.tag_id = t.id
			 GROUP BY t.id ORDER BY t.name COLLATE NOCASE`
		)
		.all() as TagRow[];
}

/** Create-or-get by name (case-insensitive) — powers inline creation while tagging. */
export function addTag(db: Database, name: string): number {
	const n = name.trim();
	if (!n) throw new Error('name required');
	return db
		.prepare(
			'INSERT INTO tags (name) VALUES (?) ON CONFLICT (name) DO UPDATE SET name = name RETURNING id'
		)
		.pluck()
		.get(n) as number;
}

export function renameTag(db: Database, id: number, newName: string): void {
	const name = newName.trim();
	if (!name) throw new Error('name required');
	db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(name, id);
}

/** Deleting a Tag detaches it everywhere — Transactions keep their Categories (story 16). */
export function deleteTag(db: Database, id: number): void {
	db.transaction(() => {
		db.prepare('DELETE FROM transaction_tags WHERE tag_id = ?').run(id);
		db.prepare('DELETE FROM rule_tags WHERE tag_id = ?').run(id);
		db.prepare('DELETE FROM tags WHERE id = ?').run(id);
	})();
}

export function attachTag(db: Database, txnId: number, tagId: number): void {
	db.prepare('INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)').run(
		txnId,
		tagId
	);
}

export function detachTag(db: Database, txnId: number, tagId: number): void {
	db.prepare('DELETE FROM transaction_tags WHERE transaction_id = ? AND tag_id = ?').run(
		txnId,
		tagId
	);
}

/** Bulk tagging (story 19) — idempotent, one statement per Transaction. */
export function bulkAttach(db: Database, txnIds: number[], tagId: number): void {
	const insert = db.prepare(
		'INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)'
	);
	db.transaction(() => {
		for (const id of txnIds) insert.run(id, tagId);
	})();
}

/** Tags for a set of ledger rows, keyed by transaction id. */
export function tagsFor(db: Database, txnIds: number[]): Map<number, { id: number; name: string }[]> {
	const out = new Map<number, { id: number; name: string }[]>();
	if (txnIds.length === 0) return out;
	const rows = db
		.prepare(
			`SELECT tt.transaction_id, t.id, t.name FROM transaction_tags tt
			 JOIN tags t ON t.id = tt.tag_id
			 WHERE tt.transaction_id IN (${txnIds.map(() => '?').join(',')})
			 ORDER BY t.name COLLATE NOCASE`
		)
		.all(...txnIds) as { transaction_id: number; id: number; name: string }[];
	for (const r of rows) {
		const list = out.get(r.transaction_id) ?? [];
		list.push({ id: r.id, name: r.name });
		out.set(r.transaction_id, list);
	}
	return out;
}
