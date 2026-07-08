import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import { cashFlow } from './cashflow';
import type { FilterSet } from './filters';

const TODAY = '2026-07-04';
const ALL: FilterSet = { date: { preset: 'all' } };

function makeDb() {
	const db = new Database(':memory:');
	migrate(db);
	db.prepare("INSERT INTO connections (institution_name, plaid_item_id) VALUES ('B', 'i')").run();
	db.prepare(
		"INSERT INTO accounts (connection_id, plaid_account_id, name, type, subtype) VALUES (1, 'a', 'Checking', 'depository', 'checking')"
	).run();
	return db;
}

let seq = 0;
function insert(
	db: Database.Database,
	rows: { date?: string; amount_cents: number; category?: string; is_transfer?: number }[]
) {
	const stmt = db.prepare(
		`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, amount_cents, category_id, is_transfer)
		 VALUES (1, ?, ?, 'FX', ?, (SELECT id FROM categories WHERE name = ?), ?)`
	);
	for (const r of rows)
		stmt.run(`fx-${++seq}`, r.date ?? '2026-07-02', r.amount_cents, r.category ?? null, r.is_transfer ?? 0);
}

const into = (cf: ReturnType<typeof cashFlow>) =>
	cf.links.filter((l) => l.target === 'spine').reduce((s, l) => s + l.value_cents, 0);
const outOf = (cf: ReturnType<typeof cashFlow>) =>
	cf.links.filter((l) => l.source === 'spine').reduce((s, l) => s + l.value_cents, 0);

test('savings case: links conserve money and the Savings ribbon is the residual', () => {
	const db = makeDb();
	insert(db, [
		{ amount_cents: 500_000, category: 'Income' },
		{ amount_cents: 20_000, category: 'Interest' },
		{ amount_cents: -120_000, category: 'Groceries' },
		{ amount_cents: -80_000, category: 'Travel' }
	]);
	const cf = cashFlow(db, { date: { preset: 'this-month' } }, TODAY);
	expect(cf.income_cents).toBe(520_000);
	expect(cf.expenses_cents).toBe(200_000);
	// conservation: everything entering the spine leaves it
	expect(into(cf)).toBe(520_000);
	expect(outOf(cf)).toBe(520_000);
	const savings = cf.links.find((l) => l.target === 'savings');
	expect(savings?.value_cents).toBe(320_000);
	// the savings rate equals the residual ribbon by construction
	expect(cf.savings_rate).toBe(320_000 / 520_000);
	expect(cf.nodes.find((n) => n.kind === 'shortfall')).toBeUndefined();
});

test('shortfall case: a Shortfall source feeds the spine so outflows are accounted', () => {
	const db = makeDb();
	insert(db, [
		{ amount_cents: 100_000, category: 'Income' },
		{ amount_cents: -150_000, category: 'Groceries' }
	]);
	const cf = cashFlow(db, ALL, TODAY);
	const short = cf.links.find((l) => l.source === 'shortfall');
	expect(short?.value_cents).toBe(50_000);
	expect(into(cf)).toBe(150_000); // income + shortfall
	expect(outOf(cf)).toBe(150_000); // expenses
	expect(cf.savings_rate).toBe(-0.5);
	expect(cf.nodes.find((n) => n.kind === 'savings')).toBeUndefined();
});

test('savings rate is null when the period has no income', () => {
	const db = makeDb();
	insert(db, [{ amount_cents: -5_000, category: 'Coffee' }]);
	const cf = cashFlow(db, ALL, TODAY);
	expect(cf.savings_rate).toBeNull();
	expect(cf.nodes.find((n) => n.kind === 'savings')).toBeUndefined();
});

test('Transfers never enter the flow; filters narrow it', () => {
	const db = makeDb();
	insert(db, [
		{ amount_cents: 300_000, category: 'Income' },
		{ amount_cents: -50_000, category: 'Groceries' },
		{ amount_cents: -30_000, category: 'Travel' },
		{ amount_cents: -100_000, is_transfer: 1 } // credit-card payment leg
	]);
	const all = cashFlow(db, ALL, TODAY);
	expect(all.expenses_cents).toBe(80_000);

	const travelGroup = db
		.prepare("SELECT id FROM category_groups WHERE name = 'Travel & Lifestyle'")
		.pluck()
		.get() as number;
	const narrowed = cashFlow(db, { groups: { exclude: [travelGroup] }, date: { preset: 'all' } }, TODAY);
	expect(narrowed.expenses_cents).toBe(50_000);
	expect(narrowed.nodes.filter((n) => n.kind === 'group')).toHaveLength(1);
});

test('income nodes carry Category filters, expense nodes Group filters (ribbon click)', () => {
	const db = makeDb();
	insert(db, [
		{ amount_cents: 300_000, category: 'Income' },
		{ amount_cents: -50_000, category: 'Groceries' }
	]);
	const cf = cashFlow(db, ALL, TODAY);
	const incomeNode = cf.nodes.find((n) => n.kind === 'income');
	expect(incomeNode?.filterKind).toBe('categories');
	const groupNode = cf.nodes.find((n) => n.kind === 'group');
	expect(groupNode?.filterKind).toBe('groups');
	expect(groupNode?.label).toBe('Food & Dining');
});

test('monthly bars zero-fill the resolved range', () => {
	const db = makeDb();
	insert(db, [
		{ date: '2026-05-10', amount_cents: 200_000, category: 'Income' },
		{ date: '2026-07-01', amount_cents: -40_000, category: 'Dining' }
		// June: silent — must appear as zeros
	]);
	const cf = cashFlow(db, { date: { preset: 'last-3-months' } }, TODAY);
	expect(cf.months).toEqual([
		{ month: '2026-05', income_cents: 200_000, expenses_cents: 0 },
		{ month: '2026-06', income_cents: 0, expenses_cents: 0 },
		{ month: '2026-07', income_cents: 0, expenses_cents: 40_000 }
	]);
});
