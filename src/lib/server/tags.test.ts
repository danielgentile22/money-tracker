import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import { listTags, addTag, renameTag, deleteTag, attachTag, detachTag, bulkAttach, tagsFor } from './tags';

function makeDb() {
	const db = new Database(':memory:');
	migrate(db);
	db.prepare("INSERT INTO connections (institution_name, plaid_item_id) VALUES ('B', 'i')").run();
	db.prepare(
		"INSERT INTO accounts (connection_id, plaid_account_id, name, type) VALUES (1, 'a', 'Checking', 'depository')"
	).run();
	return db;
}

function insertTxn(db: Database.Database, pid: string): number {
	return db
		.prepare(
			`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, merchant, amount_cents)
			 VALUES (1, ?, '2026-06-01', 'X', 'X', -100) RETURNING id`
		)
		.pluck()
		.get(pid) as number;
}

test('Tag CRUD with usage counts; add is create-or-get case-insensitively', () => {
	const db = makeDb();
	const id = addTag(db, 'Vacation 2026');
	expect(addTag(db, 'vacation 2026')).toBe(id);
	renameTag(db, id, 'Vacation ’26');
	expect(() => addTag(db, '  ')).toThrow(/name required/);

	const t1 = insertTxn(db, 't1');
	attachTag(db, t1, id);
	expect(listTags(db)).toEqual([{ id, name: 'Vacation ’26', usage: 1 }]);
});

test('attach is idempotent; detach removes; bulk attach covers a selection', () => {
	const db = makeDb();
	const tag = addTag(db, 'Reimbursable');
	const t1 = insertTxn(db, 't1');
	const t2 = insertTxn(db, 't2');

	attachTag(db, t1, tag);
	attachTag(db, t1, tag); // no dupe
	bulkAttach(db, [t1, t2], tag); // idempotent over t1, new on t2
	expect(db.prepare('SELECT COUNT(*) FROM transaction_tags').pluck().get()).toBe(2);

	detachTag(db, t1, tag);
	expect(tagsFor(db, [t1, t2]).get(t2)).toEqual([{ id: tag, name: 'Reimbursable' }]);
	expect(tagsFor(db, [t1, t2]).has(t1)).toBe(false);
});

test('deleting a Tag detaches it everywhere; Transactions survive', () => {
	const db = makeDb();
	const tag = addTag(db, 'Tax deductible');
	const t1 = insertTxn(db, 't1');
	attachTag(db, t1, tag);
	db.prepare('INSERT INTO rules (merchant, category_id) VALUES (?, 1)').run('X');
	db.prepare('INSERT INTO rule_tags (rule_id, tag_id) VALUES (1, ?)').run(tag);

	deleteTag(db, tag);

	expect(db.prepare('SELECT COUNT(*) FROM transaction_tags').pluck().get()).toBe(0);
	expect(db.prepare('SELECT COUNT(*) FROM rule_tags').pluck().get()).toBe(0);
	expect(db.prepare('SELECT COUNT(*) FROM transactions').pluck().get()).toBe(1);
	expect(listTags(db)).toEqual([]);
});

test('detachTag reports whether a row was actually removed', () => {
	const db = makeDb();
	const tag = addTag(db, 'Once');
	const t1 = insertTxn(db, 't1');
	attachTag(db, t1, tag);
	expect(detachTag(db, t1, tag)).toBe(true);
	expect(detachTag(db, t1, tag)).toBe(false); // already gone — stale post
});
