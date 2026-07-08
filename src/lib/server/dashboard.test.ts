import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import {
	WIDGETS,
	SECTIONS,
	readLayout,
	saveLayout,
	readSidebar,
	saveSidebar,
	buildSnapshot,
	openReviewCount,
	type LayoutEntry
} from './dashboard';

function makeDb() {
	const db = new Database(':memory:');
	migrate(db);
	return db;
}

const ids = WIDGETS.map((w) => w.id);
const allVisible = (): LayoutEntry[] =>
	WIDGETS.map((w) => ({ id: w.id, hidden: false, size: w.defaultSize }));

// --- reconciliation ---

test('absent setting yields the registry defaults: lean set visible, default sizes', () => {
	const layout = readLayout(makeDb());
	expect(layout).toEqual(
		WIDGETS.map((w) => ({ id: w.id, hidden: w.defaultHidden, size: w.defaultSize }))
	);
	// the lean default set is exactly the four glanceables
	expect(layout.filter((e) => !e.hidden).map((e) => e.id)).toEqual([
		'month-summary',
		'budget',
		'net-worth',
		'concerns'
	]);
});

test('unknown ids are dropped silently; missing ids appended at the end with defaults', () => {
	const db = makeDb();
	db.prepare("INSERT INTO settings (key, value) VALUES ('dashboard_layout', ?)").run(
		JSON.stringify([
			{ id: 'concerns', hidden: true, size: 'small' },
			{ id: 'crystal-ball', hidden: false, size: 'large' }, // no such widget
			{ id: 'net-worth', hidden: false, size: 'large' }
		])
	);
	const layout = readLayout(db);
	expect(layout[0]).toEqual({ id: 'concerns', hidden: true, size: 'small' });
	expect(layout[1]).toEqual({ id: 'net-worth', hidden: false, size: 'large' });
	expect(layout.map((e) => e.id)).not.toContain('crystal-ball');
	// the rest of the registry follows, with registry defaults, in registry order
	expect(layout.map((e) => e.id)).toEqual([
		'concerns',
		'net-worth',
		...ids.filter((id) => id !== 'concerns' && id !== 'net-worth')
	]);
});

test('unsupported or missing sizes clamp to the widget default', () => {
	const db = makeDb();
	db.prepare("INSERT INTO settings (key, value) VALUES ('dashboard_layout', ?)").run(
		JSON.stringify([
			{ id: 'insight', hidden: false, size: 'small' }, // insight is large-only
			{ id: 'budget', hidden: false } // no size at all (pre-Session-6 save)
		])
	);
	const layout = readLayout(db);
	expect(layout[0]).toEqual({ id: 'insight', hidden: false, size: 'large' });
	expect(layout[1]).toEqual({ id: 'budget', hidden: false, size: 'medium' });
});

test('corrupt or non-array setting reads as the default layout, never an error', () => {
	const db = makeDb();
	db.prepare("INSERT INTO settings (key, value) VALUES ('dashboard_layout', 'not json {')").run();
	expect(readLayout(db)).toHaveLength(ids.length);
});

// --- persistence ---

test('save then read round-trips order, hidden flags, and sizes', () => {
	const db = makeDb();
	const reordered = [...WIDGETS]
		.reverse()
		.map((w) => ({ id: w.id, hidden: w.id === 'budget', size: w.defaultSize }));
	saveLayout(db, reordered);
	expect(readLayout(db)).toEqual(reordered);
});

test('invalid saves are rejected: unknown id, duplicate id, unsupported size', () => {
	const db = makeDb();
	expect(() => saveLayout(db, [{ id: 'nope', hidden: false, size: 'medium' }])).toThrow(/unknown/);
	expect(() =>
		saveLayout(db, [
			{ id: 'budget', hidden: false, size: 'medium' },
			{ id: 'budget', hidden: true, size: 'medium' }
		])
	).toThrow(/duplicate/);
	expect(() => saveLayout(db, [{ id: 'insight', hidden: false, size: 'small' }])).toThrow(
		/unsupported size/
	);
	// nothing was persisted by the failed saves
	expect(readLayout(db)).toEqual(
		WIDGETS.map((w) => ({ id: w.id, hidden: w.defaultHidden, size: w.defaultSize }))
	);
});

// --- sidebar ---

test('absent sidebar setting yields all sections visible in spine order', () => {
	expect(readSidebar(makeDb())).toEqual(SECTIONS.map((id) => ({ id, hidden: false })));
});

test('sidebar round-trips order and hidden flags; Settings can never be hidden', () => {
	const db = makeDb();
	const reordered = [...SECTIONS].reverse().map((id) => ({ id, hidden: id === '/recurring' }));
	saveSidebar(db, reordered);
	expect(readSidebar(db)).toEqual(reordered);
	// hiding /settings is silently ignored on save and on read
	saveSidebar(db, SECTIONS.map((id) => ({ id, hidden: true })));
	const entries = readSidebar(db);
	expect(entries.find((e) => e.id === '/settings')!.hidden).toBe(false);
	expect(entries.filter((e) => e.hidden)).toHaveLength(SECTIONS.length - 1);
});

test('invalid sidebar saves are rejected: unknown or duplicate section', () => {
	const db = makeDb();
	expect(() => saveSidebar(db, [{ id: '/nope', hidden: false }])).toThrow(/unknown/);
	expect(() =>
		saveSidebar(db, [
			{ id: '/transactions', hidden: false },
			{ id: '/transactions', hidden: true }
		])
	).toThrow(/duplicate/);
});

test('the spine is Dashboard/Transactions/Categories/Recurring/Splits/Reports/Accounts/Settings', () => {
	expect(SECTIONS).toEqual([
		'/',
		'/transactions',
		'/categories',
		'/recurring',
		'/splits',
		'/reports',
		'/accounts',
		'/settings'
	]);
});

test('sidebar config predating the Categories page reconciles: Budgets becomes Categories in place, Cash Flow drops', () => {
	const db = makeDb();
	// what an owner who reordered the old nav has stored (slice 5 retires two routes)
	db.prepare("INSERT INTO settings (key, value) VALUES ('sidebar_layout', ?)").run(
		JSON.stringify([
			{ id: '/transactions', hidden: false },
			{ id: '/budgets', hidden: false },
			{ id: '/cash-flow', hidden: true },
			{ id: '/', hidden: false }
		])
	);
	const entries = readSidebar(db);
	const ids = entries.map((e) => e.id);
	expect(ids).not.toContain('/budgets');
	expect(ids).not.toContain('/cash-flow');
	// the Categories page replaced Budgets — it inherits Budgets' spot, visible
	expect(ids.slice(0, 3)).toEqual(['/transactions', '/categories', '/']);
	expect(entries.find((e) => e.id === '/categories')!.hidden).toBe(false);
	expect(ids.filter((id) => id === '/categories')).toHaveLength(1);
});

// --- snapshot ---

test('hidden widgets are absent from the snapshot; visible ones present', () => {
	const db = makeDb();
	const layout = allVisible().map((e) => ({
		...e,
		hidden: e.id !== 'concerns' && e.id !== 'run-rate'
	}));
	const snap = buildSnapshot(db, layout, '2026-07-04');
	expect(Object.keys(snap).sort()).toEqual(['concerns', 'run-rate']);
});

test('thin data produces empty-state values, not errors (fresh db, everything visible)', () => {
	const db = makeDb();
	const snap = buildSnapshot(db, allVisible(), '2026-07-04');
	expect(Object.keys(snap).sort()).toEqual([...ids].sort());
	expect(snap['month-summary']!.current.txn_count).toBe(0);
	expect(snap['month-summary']!.trailing).toHaveLength(12);
	expect(snap['net-worth']!.series).toEqual([]);
	expect(snap['recent-transactions']!.rows).toEqual([]);
	expect(snap.concerns).toEqual({ top: [], total: 0 });
	expect(snap['run-rate']!.runRate).toMatchObject({ insufficient: true });
	expect(snap.insight).toEqual({ explain: null, summary: null });
});

test('snapshot slices carry real data once seeded', () => {
	const db = makeDb();
	db.prepare("INSERT INTO connections (institution_name, plaid_item_id) VALUES ('B', 'i')").run();
	db.prepare(
		"INSERT INTO accounts (connection_id, plaid_account_id, name, type, subtype) VALUES (1, 'a', 'Checking', 'depository', 'checking')"
	).run();
	db.prepare(
		`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, merchant, amount_cents,
		   category_id, is_transfer, is_saved, is_investment_activity)
		 VALUES (1, 't1', '2026-07-02', 'Latte', 'Cafe', -450,
		   (SELECT id FROM categories WHERE name = 'Dining'), 0, 0, 0)`
	).run();
	const snap = buildSnapshot(db, allVisible(), '2026-07-04');
	expect(snap['month-summary']!.current.expenses_cents).toBe(450);
	expect(snap['recent-transactions']!.rows[0]).toMatchObject({
		merchant: 'Cafe',
		amount_cents: -450
	});
	expect(snap['spending-trend']!.months.at(-1)).toMatchObject({ total_cents: 450 });
	expect(snap.budget!.top[0]).toMatchObject({ name: 'Dining', actual_cents: 450 });
});

// --- review badge count ---

test('openReviewCount reflects only open review items', () => {
	const db = makeDb();
	const ins = db.prepare("INSERT INTO review_items (kind, payload, status) VALUES (?, '{}', ?)");
	ins.run('transfer-ambiguity', 'open');
	ins.run('proposal', 'open');
	ins.run('proposal', 'approved');
	ins.run('transfer-ambiguity', 'rejected');
	expect(openReviewCount(db)).toBe(2);
});
