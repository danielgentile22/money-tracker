import type { Database } from 'better-sqlite3';
import { recategorizeAll } from './categorize-db';

/**
 * A Correction sets the Transaction's Category (source 'correction' — beats
 * everything, never overwritten) and may attach Tags. With applyToFuture it
 * mints or updates the unranged Rule for that Merchant — carrying the chosen
 * Tags (story 22) — and re-applies over past Transactions.
 */
export function applyCorrection(
	db: Database,
	txnId: number,
	opts: {
		categoryId?: number;
		newCategoryName?: string;
		applyToFuture: boolean;
		tagIds?: number[];
	}
): void {
	const txn = db
		.prepare('SELECT id, merchant, name, date FROM transactions WHERE id = ?')
		.get(txnId) as { id: number; merchant: string | null; name: string; date: string } | undefined;
	if (!txn) throw new Error(`no Transaction ${txnId}`);

	let categoryId = opts.categoryId;
	const newName = opts.newCategoryName?.trim();
	if (newName) {
		// inline-created Categories land in the 'Other' Group; move them in Settings
		categoryId = db
			.prepare(
				`INSERT INTO categories (name, group_id) VALUES (?, (SELECT id FROM category_groups WHERE name = 'Other'))
				 ON CONFLICT (name) DO UPDATE SET name = name RETURNING id`
			)
			.pluck()
			.get(newName) as number;
	}
	if (!categoryId) throw new Error('a Category is required');

	const merchant = txn.merchant ?? txn.name;
	const tagIds = opts.tagIds ?? [];
	db.transaction(() => {
		db.prepare(
			"UPDATE transactions SET category_id = ?, category_source = 'correction', unresolved = 0 WHERE id = ?"
		).run(categoryId, txnId);
		const attach = db.prepare(
			'INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)'
		);
		for (const tagId of tagIds) attach.run(txnId, tagId);
		if (opts.applyToFuture) {
			mintRule(db, merchant, categoryId, `Correction on "${merchant}", ${today()}`, tagIds);
		}
	})();
	if (opts.applyToFuture) recategorizeAll(db);
}

/**
 * Bulk Correction (CONTEXT.md): one Category over many selected Transactions,
 * always a one-off batch fix — never mints a Rule. Teach a pattern by
 * correcting one Transaction singly.
 */
export function applyBulkCorrection(db: Database, txnIds: number[], categoryId: number): void {
	const set = db.prepare(
		"UPDATE transactions SET category_id = ?, category_source = 'correction', unresolved = 0 WHERE id = ?"
	);
	db.transaction(() => {
		for (const id of txnIds) set.run(categoryId, id);
	})();
}

/** Mint or update the unranged Rule for a Merchant (Corrections and approved Proposals). */
export function mintRule(
	db: Database,
	merchant: string,
	categoryId: number,
	provenance: string,
	tagIds: number[] = []
): void {
	const existing = db
		.prepare(
			'SELECT id FROM rules WHERE merchant = ? COLLATE NOCASE AND min_amount_cents IS NULL AND max_amount_cents IS NULL'
		)
		.pluck()
		.get(merchant) as number | undefined;
	let ruleId: number;
	if (existing) {
		db.prepare('UPDATE rules SET category_id = ?, provenance = ? WHERE id = ?').run(
			categoryId,
			provenance,
			existing
		);
		ruleId = existing;
	} else {
		ruleId = db
			.prepare('INSERT INTO rules (merchant, category_id, provenance) VALUES (?, ?, ?) RETURNING id')
			.pluck()
			.get(merchant, categoryId, provenance) as number;
	}
	const attach = db.prepare('INSERT OR IGNORE INTO rule_tags (rule_id, tag_id) VALUES (?, ?)');
	for (const tagId of tagIds) attach.run(ruleId, tagId);
}

export function updateRule(
	db: Database,
	ruleId: number,
	fields: {
		merchant: string;
		minAmountCents: number | null;
		maxAmountCents: number | null;
		categoryId: number | null; // null = tag-only Rule
		tagIds?: number[];
	}
): void {
	if (fields.categoryId == null && (fields.tagIds ?? []).length === 0)
		throw new Error('a Rule needs a Category, Tags, or both');
	db.transaction(() => {
		db.prepare(
			'UPDATE rules SET merchant = ?, min_amount_cents = ?, max_amount_cents = ?, category_id = ? WHERE id = ?'
		).run(fields.merchant, fields.minAmountCents, fields.maxAmountCents, fields.categoryId, ruleId);
		if (fields.tagIds) {
			db.prepare('DELETE FROM rule_tags WHERE rule_id = ?').run(ruleId);
			const attach = db.prepare('INSERT INTO rule_tags (rule_id, tag_id) VALUES (?, ?)');
			for (const tagId of new Set(fields.tagIds)) attach.run(ruleId, tagId);
		}
	})();
	recategorizeAll(db);
}

/** Deleting a Rule reverts its non-correction Transactions to the Plaid mapping. */
export function deleteRule(db: Database, ruleId: number): void {
	db.transaction(() => {
		db.prepare('DELETE FROM rule_tags WHERE rule_id = ?').run(ruleId);
		db.prepare('DELETE FROM rules WHERE id = ?').run(ruleId);
	})();
	recategorizeAll(db);
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}
