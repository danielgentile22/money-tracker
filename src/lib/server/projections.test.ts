import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import { runRateProjection, project529, plans529, counterfactual } from './projections';
import { upsertConcerns, dismissConcern } from './concerns';

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

let seq = 0;
function txn(db: Database.Database, date: string, cents: number) {
	db.prepare(
		`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, merchant, amount_cents)
		 VALUES (1, ?, ?, 'FX', 'fx', ?)`
	).run(`pj-${++seq}`, date, cents);
}

/** Mar data so Apr–Jun are full countable months; nets +1000, +1400, +1200 dollars. */
function seedThreeMonths(db: Database.Database) {
	txn(db, '2026-03-20', 100_000);
	txn(db, '2026-04-01', 300_000);
	txn(db, '2026-04-15', -200_000);
	txn(db, '2026-05-01', 300_000);
	txn(db, '2026-05-15', -160_000);
	txn(db, '2026-06-01', 300_000);
	txn(db, '2026-06-15', -180_000);
}

test('run-rate arithmetic matches the hand-computed fixture exactly', () => {
	const db = makeDb();
	seedThreeMonths(db);

	const p = runRateProjection(db, TODAY);
	if (p.insufficient) throw new Error('unexpected insufficient');
	// avg of (+1000, +1400, +1200) = $1,200/mo; no recurring deltas
	expect(p.base_avg_cents).toBe(120_000);
	expect(p.recurring_delta_cents).toBe(0);
	expect(p.monthly_net_cents).toBe(120_000);
	expect(p.twelve_month_cents).toBe(1_440_000);
	expect(p.months).toHaveLength(12);
	expect(p.months[0]).toEqual({ month: '2026-08', projected_cents: 120_000 });
	expect(p.months[11]).toEqual({ month: '2027-07', projected_cents: 120_000 }); // year wrap
	expect(p.assumptions.some((a) => a.includes('$1,200.00'))).toBe(true);
});

test('a recurring price change is carried forward as a monthly delta', () => {
	const db = makeDb();
	seedThreeMonths(db);
	// price-crept series: typical $9.99, latest $12.99 → −$3.00/mo going forward
	db.prepare(
		`INSERT INTO recurring_series (merchant, cadence, typical_amount_cents, last_amount_cents, first_seen, last_seen)
		 VALUES ('netflix', 'monthly', 999, 1299, '2026-01-15', '2026-07-15')`
	).run();

	const p = runRateProjection(db, TODAY);
	if (p.insufficient) throw new Error('unexpected insufficient');
	expect(p.recurring_delta_cents).toBe(-300);
	expect(p.monthly_net_cents).toBe(119_700);
	expect(p.assumptions.some((a) => a.includes('netflix'))).toBe(true);
});

test('annual and weekly deltas are monthly-ized', () => {
	const db = makeDb();
	seedThreeMonths(db);
	db.prepare(
		`INSERT INTO recurring_series (merchant, cadence, typical_amount_cents, last_amount_cents, first_seen, last_seen)
		 VALUES ('dropbox', 'annual', 10_000, 13_600, '2025-06-01', '2026-06-01')`
	).run(); // +$36/yr → −$3.00/mo
	const p = runRateProjection(db, TODAY);
	if (p.insufficient) throw new Error('unexpected insufficient');
	expect(p.recurring_delta_cents).toBe(-300);
});

// #52: a new-price bill already inside the trailing window is partly embedded in
// baseAvg — carrying the full (last − typical) would double count it. One of the
// three window bills at the new price discounts the delta to two-thirds.
test('a price change already in the window is not double counted', () => {
	const db = makeDb();
	seedThreeMonths(db);
	const seriesId = db
		.prepare(
			`INSERT INTO recurring_series (merchant, cadence, typical_amount_cents, last_amount_cents, first_seen, last_seen)
			 VALUES ('netflix', 'monthly', 999, 1299, '2026-01-15', '2026-06-15') RETURNING id`
		)
		.pluck()
		.get() as number;
	// one member bill at the NEW price lands inside the Apr–Jun window
	db.prepare(
		`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, merchant, amount_cents, recurring_series_id)
		 VALUES (1, 'nf-jun', '2026-06-15', 'Netflix', 'netflix', -1299, ?)`
	).run(seriesId);

	const p = runRateProjection(db, TODAY);
	if (p.insufficient) throw new Error('unexpected insufficient');
	// (1299 − 999) × (1 − 1/3) = 300 × 2/3 = 200 → −$2.00/mo, not the full −$3.00
	expect(p.recurring_delta_cents).toBe(-200);
});

test('below 3 full months the Projection declares itself insufficient', () => {
	const db = makeDb();
	txn(db, '2026-06-01', 300_000);
	txn(db, '2026-06-15', -100_000);

	// June-only data: the conservative counter treats the first data month as partial
	const p = runRateProjection(db, TODAY);
	expect(p).toEqual({ insufficient: true, needMonths: 3, haveMonths: 0 });
});

// --- 529 funding ---

test('529 compounding matches the hand-computed table', () => {
	// $10,000 at 5%/yr, $100/mo contributions, 2 years to college:
	// y1: 10,000×1.05 + 1,200 = 11,700 · y2: 11,700×1.05 + 1,200 = 13,485
	const plan = project529(
		{
			account_id: 1,
			account_name: '529 A',
			beneficiary: 'A',
			age: 16,
			target_cents: 2_000_000,
			balance_cents: 1_000_000,
			monthly_contribution_cents: 10_000,
			contribution_source: 'detected'
		},
		{ returnPct: 5, todayYear: 2026 }
	);
	expect(plan.college_year).toBe(2028);
	expect(plan.projected_cents).toBe(1_348_500);
	expect(plan.funded_pct).toBeCloseTo(67.4, 1);
	expect(plan.gap_cents).toBe(651_500);
	expect(plan.path).toEqual([
		{ year: 2026, balance_cents: 1_000_000 },
		{ year: 2027, balance_cents: 1_170_000 },
		{ year: 2028, balance_cents: 1_348_500 }
	]);
	expect(plan.assumptions.some((a) => a.includes('5%'))).toBe(true);
	expect(plan.assumptions.some((a) => a.toLowerCase().includes('detected'))).toBe(true);
});

test('529 contribution rate derives from one-sided saved legs, split across accounts', () => {
	const db = makeDb();
	db.prepare(
		"INSERT INTO accounts (connection_id, plaid_account_id, name, type, subtype, current_balance_cents) VALUES (1, 'p1', '529 Alice', 'investment', '529', 1_000_000)"
	).run();
	db.prepare(
		"INSERT INTO accounts (connection_id, plaid_account_id, name, type, subtype, current_balance_cents) VALUES (1, 'p2', '529 Beth', 'investment', '529', 500_000)"
	).run();
	// anchor history so Apr–Jun are full months
	txn(db, '2026-03-20', 100_000);
	// $600/mo of one-sided saved legs (p1-12 flow): is_saved=1, no peer
	for (const m of ['2026-04', '2026-05', '2026-06']) {
		db.prepare(
			`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, merchant, amount_cents, is_transfer, is_saved)
			 VALUES (1, ?, ?, 'TRANSFER', 'transfer', -60_000, 1, 1)`
		).run(`sv-${m}`, `${m}-15`);
	}
	// a PAIRED saved leg into a savings account is attributable — never a 529 contribution
	db.prepare(
		`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, merchant, amount_cents, is_transfer, is_saved, transfer_peer_id)
		 VALUES (1, 'paired', '2026-06-20', 'TRANSFER', 'transfer', -99_000, 1, 1, 1)`
	).run();
	for (const [k, v] of [
		['529_2_name', 'Alice'], ['529_2_birth_year', '2010'], ['529_2_target_dollars', '20000'], // age 16 in 2026
		['529_3_name', 'Beth'], ['529_3_birth_year', '2016'], ['529_3_target_dollars', '20000'] // age 10
	])
		db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(k, v);

	const plans = plans529(db, TODAY);
	expect(plans).toHaveLength(2);
	const alice = plans.find((p) => !('needsSetup' in p) && p.beneficiary === 'Alice');
	if (!alice || 'needsSetup' in alice) throw new Error('Alice plan missing');
	expect(alice.monthly_contribution_cents).toBe(30_000); // $600/mo ÷ 2 accounts
	expect(alice.contribution_source).toBe('detected');
	expect(alice.assumptions.some((a) => a.includes('split evenly'))).toBe(true);
});

test('529 manual override beats detection and is named in the assumptions', () => {
	const db = makeDb();
	db.prepare(
		"INSERT INTO accounts (connection_id, plaid_account_id, name, type, subtype, current_balance_cents) VALUES (1, 'p1', '529 Alice', 'investment', '529', 1_000_000)"
	).run();
	txn(db, '2026-03-20', 100_000);
	for (const [k, v] of [
		['529_2_name', 'Alice'], ['529_2_birth_year', '2010'], ['529_2_target_dollars', '20000'],
		['529_2_override_monthly_dollars', '250']
	])
		db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(k, v);

	const plans = plans529(db, TODAY);
	const alice = plans[0];
	if ('needsSetup' in alice) throw new Error('unexpected needsSetup');
	expect(alice.monthly_contribution_cents).toBe(25_000);
	expect(alice.contribution_source).toBe('override');
	expect(alice.assumptions.some((a) => a.toLowerCase().includes('manual'))).toBe(true);
});

test('unconfigured 529 Accounts surface as needsSetup prompts, never empty charts', () => {
	const db = makeDb();
	db.prepare(
		"INSERT INTO accounts (connection_id, plaid_account_id, name, type, subtype, current_balance_cents) VALUES (1, 'p1', '529 Alice', 'investment', '529', 1_000_000)"
	).run();
	const plans = plans529(db, TODAY);
	expect(plans).toEqual([{ needsSetup: true, account_id: 2, account_name: '529 Alice' }]);
});

// #14: a fixed birth year keeps the college year anchored to the child — it must
// NOT drift a year later every calendar year (the bug with a static "age today").
test('529 college year is stable across calendar years (no drift)', () => {
	const db = makeDb();
	db.prepare(
		"INSERT INTO accounts (connection_id, plaid_account_id, name, type, subtype, current_balance_cents) VALUES (1, 'p1', '529 Alice', 'investment', '529', 1_000_000)"
	).run();
	for (const [k, v] of [
		['529_2_name', 'Alice'], ['529_2_birth_year', '2016'], ['529_2_target_dollars', '20000'] // college at 18 = 2034
	])
		db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(k, v);

	const collegeYear = (today: string) => {
		const p = plans529(db, today)[0];
		if ('needsSetup' in p) throw new Error('unexpected needsSetup');
		return p.college_year;
	};
	expect(collegeYear('2026-07-15')).toBe(2034);
	expect(collegeYear('2028-01-01')).toBe(2034); // two years later, same college year
});

// --- counterfactual savings ---

test('counterfactual sums only active overage-type Concerns, annualized; dismissal updates it', () => {
	const db = makeDb();
	upsertConcerns(db, [
		{
			detector: 'budget-overage', subject: 'category:5', period: '2026-07', severity: 50,
			title: 'Dining over', figures: { target_cents: 40_000, actual_cents: 52_000, overage_cents: 12_000 }, txn_ids: []
		},
		{
			detector: 'spend-spike', subject: 'category:6', period: '2026-07', severity: 40,
			title: 'Groceries spiking', figures: { mtd_cents: 31_000, avg_cents: 20_000, ratio: 1.55 }, txn_ids: []
		},
		{
			detector: 'fees-interest', subject: 'txn:9', period: '2026-07-02', severity: 20,
			title: 'A fee', figures: { amount_cents: 3_500 }, txn_ids: [9]
		}
	]);

	const c = counterfactual(db);
	expect(c.monthly_cents).toBe(23_000); // 12,000 + (31,000 − 20,000)
	expect(c.annual_cents).toBe(276_000);
	expect(c.lines).toHaveLength(2);
	expect(c.assumptions.some((a) => a.includes('repeat'))).toBe(true);

	dismissConcern(db, c.lines[0].concern_id);
	expect(counterfactual(db).monthly_cents).toBe(11_000);

	const empty = counterfactual(makeDb());
	expect(empty.lines).toEqual([]);
	expect(empty.monthly_cents).toBe(0);
});

// #15: a category that trips BOTH detectors describes the same dollars twice —
// the total keeps only the larger overage, though both lines still show.
test('counterfactual dedupes overlapping overage + spike on the same category', () => {
	const db = makeDb();
	upsertConcerns(db, [
		{
			detector: 'budget-overage', subject: 'category:5', period: '2026-07', severity: 50,
			title: 'Dining over', figures: { target_cents: 40_000, actual_cents: 52_000, overage_cents: 12_000 }, txn_ids: []
		},
		{
			detector: 'spend-spike', subject: 'category:5', period: '2026-07', severity: 40,
			title: 'Dining spiking', figures: { mtd_cents: 52_000, avg_cents: 41_000, ratio: 1.27 }, txn_ids: []
		}
	]);
	const c = counterfactual(db);
	expect(c.lines).toHaveLength(2); // both still listed
	expect(c.monthly_cents).toBe(12_000); // max(12,000, 11,000), not 23,000
	expect(c.annual_cents).toBe(144_000);
});
