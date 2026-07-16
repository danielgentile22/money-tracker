import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import {
	budgetMonth,
	budgetStatus,
	clearBudget,
	setBudget,
	setRolloverAnchor,
	type BudgetMonth
} from './budgets';
import { runDetectors } from './detectors';
import { activeConcerns } from './concerns';

const TODAY = '2026-07-15';

function makeDb() {
	const db = new Database(':memory:');
	migrate(db);
	db.prepare("INSERT INTO connections (institution_name, plaid_item_id) VALUES ('B', 'i')").run();
	db.prepare(
		"INSERT INTO accounts (connection_id, plaid_account_id, name, type, subtype) VALUES (1, 'a1', 'Checking', 'depository', 'checking')"
	).run();
	return db;
}

const catId = (db: Database.Database, name: string) =>
	db.prepare('SELECT id FROM categories WHERE name = ?').pluck().get(name) as number;

let seq = 0;
function txn(db: Database.Database, category: string, date: string, cents: number) {
	db.prepare(
		`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, merchant, amount_cents, category_id)
		 VALUES (1, ?, ?, 'FX', 'fx', ?, (SELECT id FROM categories WHERE name = ?))`
	).run(`bg-${++seq}`, date, cents, category);
}
const spend = (db: Database.Database, category: string, date: string, cents: number) =>
	txn(db, category, date, -cents);
const earn = (db: Database.Database, category: string, date: string, cents: number) =>
	txn(db, category, date, cents);

const lineOf = (snap: BudgetMonth, name: string) =>
	snap.groups.flatMap((g) => g.lines).find((l) => l.name === name)!;
const effective = (db: Database.Database, month: string, name: string) =>
	lineOf(budgetMonth(db, month), name).budget_cents;

// ---------- store: fill-forward ----------

test('a month inherits the last set amount until edited; edits freeze forward, not back', () => {
	const db = makeDb();
	const dining = catId(db, 'Dining');
	setBudget(db, dining, '2026-01', 40_000);
	expect(effective(db, '2026-01', 'Dining')).toBe(40_000);
	expect(effective(db, '2026-06', 'Dining')).toBe(40_000); // inherited
	expect(effective(db, '2025-12', 'Dining')).toBe(0); // before first row: unbudgeted

	setBudget(db, dining, '2026-03', 50_000); // diverge in March
	expect(effective(db, '2026-02', 'Dining')).toBe(40_000); // past untouched
	expect(effective(db, '2026-03', 'Dining')).toBe(50_000);
	expect(effective(db, '2026-06', 'Dining')).toBe(50_000);
});

test('editing a past month never disturbs later already-set months', () => {
	const db = makeDb();
	const dining = catId(db, 'Dining');
	setBudget(db, dining, '2026-03', 50_000);
	setBudget(db, dining, '2026-01', 10_000);
	expect(effective(db, '2026-01', 'Dining')).toBe(10_000);
	expect(effective(db, '2026-02', 'Dining')).toBe(10_000);
	expect(effective(db, '2026-03', 'Dining')).toBe(50_000); // kept its own value
});

test('clearing writes a zero row: ends fill-forward from that month, history intact', () => {
	const db = makeDb();
	const dining = catId(db, 'Dining');
	setBudget(db, dining, '2026-01', 40_000);
	clearBudget(db, dining, '2026-05');
	expect(effective(db, '2026-04', 'Dining')).toBe(40_000);
	expect(effective(db, '2026-05', 'Dining')).toBe(0);
	expect(effective(db, '2026-08', 'Dining')).toBe(0);
});

// ---------- engine: income and left to budget ----------

test('expected income sums budgeted Income-group Categories; income actuals land per line', () => {
	const db = makeDb();
	setBudget(db, catId(db, 'Income'), '2026-07', 500_000);
	setBudget(db, catId(db, 'Interest'), '2026-07', 1_000);
	earn(db, 'Income', '2026-07-01', 450_000);

	const snap = budgetMonth(db, '2026-07');
	expect(snap.income.expected_cents).toBe(501_000);
	expect(snap.income.actual_cents).toBe(450_000);
	const names = snap.income.lines.map((l) => l.name).sort();
	expect(names).toContain('Income');
	// Income Categories never appear in the expense sections; Transfer appears nowhere
	const expenseNames = snap.groups.flatMap((g) => g.lines.map((l) => l.name));
	expect(expenseNames).not.toContain('Income');
	expect(expenseNames).not.toContain('Transfer');
});

test('left to budget = expected income − allocations; goes negative when over-committed', () => {
	const db = makeDb();
	setBudget(db, catId(db, 'Income'), '2026-07', 100_000);
	setBudget(db, catId(db, 'Dining'), '2026-07', 40_000);
	setBudget(db, catId(db, 'Groceries'), '2026-07', 30_000);
	expect(budgetMonth(db, '2026-07').left_to_budget_cents).toBe(30_000); // implicit savings

	setBudget(db, catId(db, 'Shopping'), '2026-07', 50_000);
	expect(budgetMonth(db, '2026-07').left_to_budget_cents).toBe(-20_000);
});

// ---------- engine: flex retirement (ADR-0008) ----------

test('flex data left in the DB changes nothing: per-Category shape, all lines allocated', () => {
	const db = makeDb();
	setBudget(db, catId(db, 'Income'), '2026-07', 100_000);
	setBudget(db, catId(db, 'Rent & Utilities'), '2026-07', 50_000); // seeded fixed
	setBudget(db, catId(db, 'Dining'), '2026-07', 40_000); // seeded flexible
	spend(db, 'Dining', '2026-07-02', 12_000);
	// a fully-configured Flex past, straight into the tables the engine must ignore
	db.prepare("INSERT INTO flex_pool (month, amount_cents) VALUES ('2026-07', 25000)").run();
	db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('budget_mode', 'flex')").run();

	const snap = budgetMonth(db, '2026-07');
	expect(snap).not.toHaveProperty('mode');
	expect(snap).not.toHaveProperty('flex_pool');
	expect(lineOf(snap, 'Dining')).not.toHaveProperty('flex');
	expect(snap.allocated_cents).toBe(90_000); // every line counts; pool and classes ignored
	expect(snap.left_to_budget_cents).toBe(10_000);
});

// ---------- engine: rollover ----------

test('rollover: $0 at the anchor month, then budget−actual accumulates, surplus and shortfall', () => {
	const db = makeDb();
	const groceries = catId(db, 'Groceries');
	setBudget(db, groceries, '2026-04', 50_000);
	setRolloverAnchor(db, groceries, '2026-04');
	spend(db, 'Groceries', '2026-04-10', 30_000); // +20k surplus
	spend(db, 'Groceries', '2026-05-10', 60_000); // −10k shortfall
	spend(db, 'Groceries', '2026-06-10', 20_000);

	expect(lineOf(budgetMonth(db, '2026-04'), 'Groceries').rollover_cents).toBe(0); // anchor month
	expect(lineOf(budgetMonth(db, '2026-05'), 'Groceries').rollover_cents).toBe(20_000);
	const june = lineOf(budgetMonth(db, '2026-06'), 'Groceries');
	expect(june.rollover_cents).toBe(10_000); // 20k − 10k
	expect(june.available_cents).toBe(40_000); // 50k + 10k − 20k

	// months before the anchor render rollover-off
	expect(lineOf(budgetMonth(db, '2026-03'), 'Groceries').rollover_cents).toBeNull();
});

// #24: a refund the month after a purchase nets in the rollover balance instead
// of shrinking it forever (the balance is a running total).
test('rollover: a refund nets against spend and does not permanently skew the balance', () => {
	const db = makeDb();
	const groceries = catId(db, 'Groceries');
	setBudget(db, groceries, '2026-04', 50_000);
	setRolloverAnchor(db, groceries, '2026-04');
	spend(db, 'Groceries', '2026-04-10', 30_000); // $300 charge
	earn(db, 'Groceries', '2026-05-05', 30_000); // fully refunded next month
	// April surplus 20k enters May; May nets 50k budget − (−30k refund) = 80k avail
	expect(lineOf(budgetMonth(db, '2026-05'), 'Groceries').rollover_cents).toBe(20_000);
	const june = lineOf(budgetMonth(db, '2026-06'), 'Groceries');
	// entering June: (50k−30k) + (50k−(−30k)) = 20k + 80k = 100k — the charge and
	// its refund cancel, leaving two full untouched budgets
	expect(june.rollover_cents).toBe(100_000);
});

test('rollover balance is frozen history: editing a later budget never moves it', () => {
	const db = makeDb();
	const groceries = catId(db, 'Groceries');
	setBudget(db, groceries, '2026-04', 50_000);
	setRolloverAnchor(db, groceries, '2026-04');
	spend(db, 'Groceries', '2026-04-10', 30_000);
	setBudget(db, groceries, '2026-07', 999_999); // future edit
	expect(lineOf(budgetMonth(db, '2026-05'), 'Groceries').rollover_cents).toBe(20_000);
	expect(lineOf(budgetMonth(db, '2026-07'), 'Groceries').rollover_cents).toBe(120_000); // Apr +20k, May +50k, Jun +50k — July's edit affects July only
});

test('toggling rollover off and on re-anchors at $0', () => {
	const db = makeDb();
	const groceries = catId(db, 'Groceries');
	setBudget(db, groceries, '2026-04', 50_000);
	setRolloverAnchor(db, groceries, '2026-04');
	spend(db, 'Groceries', '2026-04-10', 10_000);
	expect(lineOf(budgetMonth(db, '2026-06'), 'Groceries').rollover_cents).toBe(90_000);

	setRolloverAnchor(db, groceries, null);
	expect(lineOf(budgetMonth(db, '2026-06'), 'Groceries').rollover_cents).toBeNull();

	setRolloverAnchor(db, groceries, '2026-06'); // the reset
	expect(lineOf(budgetMonth(db, '2026-06'), 'Groceries').rollover_cents).toBe(0);
	expect(lineOf(budgetMonth(db, '2026-07'), 'Groceries').rollover_cents).toBe(50_000); // June only
});

// ---------- engine: sections ----------

test('Group subtotals roll up; unbudgeted Categories show with blank budget and real spend', () => {
	const db = makeDb();
	setBudget(db, catId(db, 'Dining'), '2026-07', 40_000);
	spend(db, 'Dining', '2026-07-02', 10_000);
	spend(db, 'Coffee', '2026-07-03', 2_500); // unbudgeted, same Group

	const snap = budgetMonth(db, '2026-07');
	const food = snap.groups.find((g) => g.name === 'Food & Dining')!;
	expect(food.budget_cents).toBe(40_000);
	expect(food.actual_cents).toBe(12_500);
	const coffee = lineOf(snap, 'Coffee');
	expect(coffee.budget_cents).toBe(0); // renders blank
	expect(coffee.actual_cents).toBe(2_500);
});

test('disabled Categories and Transfer activity stay out of the plan', () => {
	const db = makeDb();
	db.prepare("UPDATE categories SET disabled = 1 WHERE name = 'Pets'").run();
	spend(db, 'Dining', '2026-07-02', 10_000);
	db.prepare('UPDATE transactions SET is_transfer = 1').run(); // that spend was a transfer after all

	const snap = budgetMonth(db, '2026-07');
	expect(snap.groups.flatMap((g) => g.lines.map((l) => l.name))).not.toContain('Pets');
	expect(lineOf(snap, 'Dining').actual_cents).toBe(0);
});

// ---------- migration ----------

test('migration: Targets become the current month\'s budget rows; classifications seed by Group', () => {
	const db = new Database(':memory:');
	migrate(db, 16); // stop before Budgets v2
	const dining = catId(db, 'Dining');
	db.prepare('INSERT INTO targets (category_id, monthly_cents) VALUES (?, ?)').run(dining, 40_000);
	migrate(db);

	const now = new Date();
	const current = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
	expect(
		db.prepare('SELECT month, amount_cents FROM budgets WHERE category_id = ?').get(dining)
	).toEqual({ month: current, amount_cents: 40_000 });
	expect(
		db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'targets'").get()
	).toBeUndefined();
	const flexOf = (name: string) =>
		db.prepare('SELECT flex FROM categories WHERE name = ?').pluck().get(name);
	// the migration still seeds the (now-unread) flex columns — data preserved, ADR-0008
	expect(flexOf('Rent & Utilities')).toBe('fixed'); // Housing
	expect(flexOf('Insurance')).toBe('fixed'); // Financial
	expect(flexOf('Dining')).toBe('flexible');
});

// ---------- detector compatibility ----------

const overages = (db: Database.Database) =>
	activeConcerns(db).filter((c) => c.detector === 'budget-overage');

test('month-to-date actual vs budget; a set budget fills forward into the viewed month', () => {
	const db = makeDb();
	setBudget(db, catId(db, 'Dining'), '2026-06', 40_000);
	spend(db, 'Dining', '2026-06-28', 90_000); // last month: irrelevant in July
	spend(db, 'Dining', '2026-07-03', 12_000);
	spend(db, 'Dining', '2026-07-10', 8_000);

	expect(budgetStatus(db, '2026-07')).toEqual([
		{ category_id: catId(db, 'Dining'), name: 'Dining', target_cents: 40_000, actual_cents: 20_000 }
	]);
});

test('overage fires the day actual crosses the budget, updates as it grows', () => {
	const db = makeDb();
	setBudget(db, catId(db, 'Dining'), '2026-07', 40_000);
	spend(db, 'Dining', '2026-07-03', 39_000);
	runDetectors(db, TODAY);
	expect(overages(db)).toHaveLength(0); // just below

	spend(db, 'Dining', '2026-07-15', 2_000); // crosses today
	runDetectors(db, TODAY);
	const fired = overages(db);
	expect(fired).toHaveLength(1);
	expect(JSON.parse(fired[0].figures)).toMatchObject({
		target_cents: 40_000,
		actual_cents: 41_000,
		overage_cents: 1_000
	});
});

// #64: a budgeted Category later disabled must drop out of budgetStatus and the
// over-budget detector — the owner can't see or clear it on /budgets, so it must
// not raise phantom Concerns.
test('a disabled Category leaves budgetStatus and stops firing overages', () => {
	const db = makeDb();
	setBudget(db, catId(db, 'Dining'), '2026-07', 10_000);
	spend(db, 'Dining', '2026-07-03', 15_000);
	runDetectors(db, TODAY);
	expect(overages(db)).toHaveLength(1);

	db.prepare("UPDATE categories SET disabled = 1 WHERE name = 'Dining'").run();
	expect(budgetStatus(db, '2026-07')).toEqual([]);
	runDetectors(db, TODAY);
	expect(overages(db)).toHaveLength(0);
});

test('clearing the budget retires its Concern on the next run', () => {
	const db = makeDb();
	setBudget(db, catId(db, 'Dining'), '2026-07', 10_000);
	spend(db, 'Dining', '2026-07-03', 15_000);
	runDetectors(db, TODAY);
	expect(overages(db)).toHaveLength(1);

	clearBudget(db, catId(db, 'Dining'), '2026-07');
	runDetectors(db, TODAY);
	expect(overages(db)).toHaveLength(0);
});
