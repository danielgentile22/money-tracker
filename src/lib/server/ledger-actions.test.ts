// The Ledger form actions' parsing/validation layer (#37) — factories are
// db-injectable, so each action runs against the shared in-memory fixture.
import { test, expect } from 'vitest';
import { makeDb, insertTxn, categoryId } from '../../test/db';
import { ledgerActions } from './ledger-actions';
import { savedReportActions } from './saved-report-actions';

function post(fields: Record<string, string | string[]>) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields))
		for (const item of Array.isArray(v) ? v : [v]) fd.append(k, item);
	// only `request` is touched by these actions; the rest of RequestEvent isn't needed
	return { request: new Request('http://localhost/t', { method: 'POST', body: fd }) } as never;
}

test('correct applies a Correction and 400s without a Category', async () => {
	const db = makeDb();
	const id = insertTxn(db, { date: '2026-06-01', amount_cents: -500, merchant: 'Blue Bottle' });
	const a = ledgerActions(db);

	const bad = (await a.correct(post({ id: String(id) }))) as { status: number };
	expect(bad.status).toBe(400);

	const coffee = categoryId(db, 'Coffee');
	const ok = await a.correct(post({ id: String(id), category_id: String(coffee) }));
	expect(ok).toEqual({ ok: true });
	const row = db.prepare('SELECT category_id, category_source FROM transactions WHERE id = ?').get(id) as {
		category_id: number;
		category_source: string;
	};
	expect(row).toEqual({ category_id: coffee, category_source: 'correction' });
});

test('tag creates inline and attaches; untag detaches', async () => {
	const db = makeDb();
	const id = insertTxn(db, { date: '2026-06-01', amount_cents: -500 });
	const a = ledgerActions(db);

	expect(((await a.tag(post({ id: String(id), name: '  ' }))) as { status: number }).status).toBe(400);
	await a.tag(post({ id: String(id), name: 'coffee-run' }));
	const tagId = db.prepare('SELECT id FROM tags WHERE name = ?').pluck().get('coffee-run') as number;
	expect(tagId).toBeTruthy();
	expect(db.prepare('SELECT COUNT(*) FROM transaction_tags WHERE transaction_id = ?').pluck().get(id)).toBe(1);

	await a.untag(post({ id: String(id), tag_id: String(tagId) }));
	expect(db.prepare('SELECT COUNT(*) FROM transaction_tags WHERE transaction_id = ?').pluck().get(id)).toBe(0);
});

test('bulkCorrect validates selection and Category, then corrects all', async () => {
	const db = makeDb();
	const ids = [
		insertTxn(db, { date: '2026-06-01', amount_cents: -100 }),
		insertTxn(db, { date: '2026-06-02', amount_cents: -200 })
	];
	const a = ledgerActions(db);
	const dining = categoryId(db, 'Dining');

	expect(((await a.bulkCorrect(post({ category_id: String(dining) }))) as { status: number }).status).toBe(400);
	expect(((await a.bulkCorrect(post({ ids: ids.map(String) }))) as { status: number }).status).toBe(400);

	await a.bulkCorrect(post({ ids: ids.map(String), category_id: String(dining) }));
	expect(
		db.prepare("SELECT COUNT(*) FROM transactions WHERE category_id = ? AND category_source = 'correction'").pluck().get(dining)
	).toBe(2);
});

test('bulkTag attaches to all; bulkUntag 400s on unknown Tag and never creates it', async () => {
	const db = makeDb();
	const ids = [
		insertTxn(db, { date: '2026-06-01', amount_cents: -100 }),
		insertTxn(db, { date: '2026-06-02', amount_cents: -200 })
	];
	const a = ledgerActions(db);

	await a.bulkTag(post({ ids: ids.map(String), name: 'trip' }));
	expect(db.prepare('SELECT COUNT(*) FROM transaction_tags').pluck().get()).toBe(2);

	const unknown = (await a.bulkUntag(post({ ids: ids.map(String), name: 'nope' }))) as {
		status: number;
		data: { message: string };
	};
	expect(unknown.status).toBe(400);
	expect(db.prepare("SELECT COUNT(*) FROM tags WHERE name = 'nope'").pluck().get()).toBe(0);

	await a.bulkUntag(post({ ids: ids.map(String), name: 'trip' }));
	expect(db.prepare('SELECT COUNT(*) FROM transaction_tags').pluck().get()).toBe(0);
});

test('bulkLookup refuses without a connected inbox', async () => {
	const db = makeDb();
	const id = insertTxn(db, { date: '2026-06-01', amount_cents: -500 });
	const res = (await ledgerActions(db).bulkLookup(post({ ids: String(id) }))) as {
		status: number;
		data: { message: string };
	};
	expect(res.status).toBe(400);
	expect(res.data.message).toContain('inbox');
});

test('lookup 400s on an unknown Transaction id', async () => {
	const db = makeDb();
	// parsing/validation only — the matched path needs the real Gmail/LLM seams,
	// which the factory binds internally (exercised via the resolution tests)
	const res = (await ledgerActions(db).lookup(post({ id: '9999' }))) as {
		status: number;
		data: { message: string };
	};
	expect(res.status).toBe(400);
	expect(res.data.message).toContain('no Transaction');
});

test('savedReportActions: save canonicalizes the query, rename validates, delete removes', async () => {
	const db = makeDb();
	const a = savedReportActions('/transactions', 'all', db);

	expect(((await a.saveReport(post({ query: 'min=5' }))) as { status: number }).status).toBe(400);

	await a.saveReport(post({ name: 'Big spends', query: 'min=5&tab=table&bogus=1' }));
	const saved = db.prepare('SELECT id, name, config FROM saved_reports').get() as {
		id: number;
		name: string;
		config: string;
	};
	expect(saved.name).toBe('Big spends');
	const { path, query } = JSON.parse(saved.config) as { path: string; query: string };
	expect(path).toBe('/transactions');
	expect(query).toContain('tab=table'); // page params survive
	expect(query).not.toContain('bogus'); // unknown params canonicalized away

	expect(((await a.renameReport(post({ id: String(saved.id), name: '' }))) as { status: number }).status).toBe(400);
	await a.renameReport(post({ id: String(saved.id), name: 'Renamed' }));
	expect(db.prepare('SELECT name FROM saved_reports WHERE id = ?').pluck().get(saved.id)).toBe('Renamed');

	await a.deleteReport(post({ id: String(saved.id) }));
	expect(db.prepare('SELECT COUNT(*) FROM saved_reports').pluck().get()).toBe(0);
});
