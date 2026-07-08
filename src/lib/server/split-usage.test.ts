import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import {
	computeShare,
	ensureSplitSchema,
	periodViews,
	recomputePeriod,
	splitSummary,
	invalidatePeriodBefore,
	type UsageJson
} from './split-usage';

function makeDb() {
	const db = new Database(':memory:');
	migrate(db);
	ensureSplitSchema(db);
	return db;
}

function addCharge(db: Database.Database, provider: string, date: string, cents: number): number {
	return db
		.prepare(
			'INSERT INTO split_charges (provider, date, amount_cents) VALUES (?, ?, ?) RETURNING id'
		)
		.pluck()
		.get(provider, date, cents) as number;
}

// Synthetic usage: two projects, one matching the pattern. Windows are
// charge-date → next-charge-date, end-exclusive.
const usage: UsageJson = {
	projects: {
		'-home-user-projects-alpha': [
			{ date: '2026-01-01', totalCost: 3 },
			{ date: '2026-01-05', totalCost: 6 },
			{ date: '2026-01-10', totalCost: 100 } // outside window when to = 01-10
		],
		'-home-user-projects-beta': [
			{ date: '2026-01-02', totalCost: 1 },
			{ date: '2026-01-12', totalCost: 2 }
		]
	}
};

test('computeShare sums matched vs total in the window, end-exclusive, substring match', () => {
	const { matched, total } = computeShare(usage, 'alpha', '2026-01-01', '2026-01-10');
	expect(matched).toBe(9);
	expect(total).toBe(10);
});

test('computeShare with open window (to = null) includes everything from the start date', () => {
	const { matched, total } = computeShare(usage, 'Alpha', '2026-01-05', null);
	expect(matched).toBe(106); // pattern is case-insensitive
	expect(total).toBe(108);
});

test('periodViews derives charge-to-charge periods, latest open, and computes shares', async () => {
	const db = makeDb();
	addCharge(db, 'claude', '2026-01-01', 1000);
	addCharge(db, 'claude', '2026-01-10', 2000);
	addCharge(db, 'other-provider', '2026-01-05', 999); // different provider, ignored

	const { views, error } = await periodViews(
		db,
		'claude',
		'alpha',
		async () => usage,
		new Date('2026-01-20T00:00:00Z')
	);

	expect(error).toBeNull();
	expect(views.map((v) => [v.from, v.to])).toEqual([
		['2026-01-01', '2026-01-10'],
		['2026-01-10', null]
	]);
	// closed period: matched 9 / total 10 → 90% of $10.00 = $9.00
	expect(views[0].amountCents).toBe(1000);
	expect(views[0].matchedCost).toBe(9);
	expect(views[0].totalCost).toBe(10);
	expect(views[0].attributableCents).toBe(900);
	expect(views[0].frozen).toBe(true);
	// open period: matched 100 / total 102
	expect(views[1].frozen).toBe(false);
	expect(views[1].attributableCents).toBe(Math.round((2000 * 100) / 102));
});

test('one fetch serves all stale periods; frozen never refetch; open refetches after ~1h', async () => {
	const db = makeDb();
	addCharge(db, 'claude', '2026-01-01', 1000);
	addCharge(db, 'claude', '2026-01-10', 2000);
	let fetches = 0;
	const fetch = async () => (fetches++, usage);
	const t0 = new Date('2026-01-20T00:00:00Z');

	await periodViews(db, 'claude', 'alpha', fetch, t0);
	expect(fetches).toBe(1); // both periods stale → one spanning fetch

	await periodViews(db, 'claude', 'alpha', fetch, new Date(t0.getTime() + 30 * 60 * 1000));
	expect(fetches).toBe(1); // closed frozen, open cache still warm

	const later = await periodViews(db, 'claude', 'alpha', fetch, new Date(t0.getTime() + 2 * 60 * 60 * 1000));
	expect(fetches).toBe(2); // only the open period refetched
	expect(later.views[0].frozen).toBe(true);

	// entering the next same-provider charge closes the open period → it freezes
	addCharge(db, 'claude', '2026-01-15', 3000);
	const after = await periodViews(db, 'claude', 'alpha', fetch, new Date(t0.getTime() + 2 * 60 * 60 * 1000));
	expect(after.views.map((v) => v.frozen)).toEqual([true, true, false]);
	expect(after.views[1].to).toBe('2026-01-15');
	expect(fetches).toBe(3); // closed-but-unfrozen + new open share one fetch
});

test('a failed fetch degrades: frozen periods still render, error says why', async () => {
	const db = makeDb();
	addCharge(db, 'claude', '2026-01-01', 1000);
	addCharge(db, 'claude', '2026-01-10', 2000);
	const t0 = new Date('2026-01-20T00:00:00Z');
	await periodViews(db, 'claude', 'alpha', async () => usage, t0);

	const offline = await periodViews(
		db,
		'claude',
		'alpha',
		async () => {
			throw new Error('npx exploded');
		},
		new Date(t0.getTime() + 2 * 60 * 60 * 1000) // open period stale again
	);
	expect(offline.error).toMatch(/npx exploded/);
	// frozen period intact; the stale open period serves its cached numbers
	expect(offline.views.map((v) => v.frozen)).toEqual([true, false]);
	expect(offline.views[0].attributableCents).toBe(900);
});

test('backdated charge: invalidatePeriodBefore drops the predecessor so it recomputes', async () => {
	const db = makeDb();
	addCharge(db, 'claude', '2026-01-01', 1000);
	addCharge(db, 'claude', '2026-01-10', 2000);
	const t0 = new Date('2026-01-20T00:00:00Z');
	await periodViews(db, 'claude', 'alpha', async () => usage, t0);

	// missed charge entered late, landing between the two above
	const midId = addCharge(db, 'claude', '2026-01-05', 500);
	invalidatePeriodBefore(db, 'claude', '2026-01-05', midId);

	const { views } = await periodViews(db, 'claude', 'alpha', async () => usage, t0);
	expect(views.map((v) => [v.from, v.to])).toEqual([
		['2026-01-01', '2026-01-05'],
		['2026-01-05', '2026-01-10'],
		['2026-01-10', null]
	]);
	// first period recomputed over its narrowed window: only Jan 1–4 usage
	expect(views[0].matchedCost).toBe(3);
	expect(views[0].totalCost).toBe(4);
});

test('recomputePeriod forces a refetch even on a frozen period', async () => {
	const db = makeDb();
	const id = addCharge(db, 'claude', '2026-01-01', 1000);
	addCharge(db, 'claude', '2026-01-10', 2000);
	let fetches = 0;
	const fetch = async () => (fetches++, usage);
	const now = new Date('2026-01-20T00:00:00Z');

	await periodViews(db, 'claude', 'alpha', fetch, now);
	await recomputePeriod(db, id, 'alpha', fetch, now);
	expect(fetches).toBe(2);
	const { views } = await periodViews(db, 'claude', 'alpha', fetch, now);
	expect(fetches).toBe(2); // recompute refroze the closed period
	expect(views[0].frozen).toBe(true);
	expect(views[0].attributableCents).toBe(900);
});

test('splitSummary: closed periods only, partner owes share of rounded sum minus payments', () => {
	const db = makeDb();
	const a = addCharge(db, 'claude', '2026-01-01', 1000);
	const b = addCharge(db, 'claude', '2026-01-10', 2000);
	const put = db.prepare(
		`INSERT INTO split_periods (charge_id, matched_cost, total_cost, attributable_cents, frozen, computed_at)
		 VALUES (?, ?, ?, ?, ?, '2026-01-20T00:00:00Z')`
	);
	put.run(a, 9, 10, 900, 1);
	put.run(b, 1, 2, 1000, 0); // open — excluded from totals
	db.prepare("INSERT INTO split_payments (date, amount_cents) VALUES ('2026-01-11', 200)").run();

	const s = splitSummary(db, 50);
	expect(s.chargedCents).toBe(1000);
	expect(s.attributableCents).toBe(900);
	expect(s.owedCents).toBe(450);
	expect(s.paidCents).toBe(200);
	expect(s.outstandingCents).toBe(250);
});

test('a transaction can back only one repayment — double-submit hits the unique index', () => {
	const db = makeDb();
	db.prepare("INSERT INTO connections (institution_name, plaid_item_id) VALUES ('B', 'i')").run();
	db.prepare(
		"INSERT INTO accounts (connection_id, plaid_account_id, name, type) VALUES (1, 'a', 'Checking', 'depository')"
	).run();
	const txn = db
		.prepare(
			`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, amount_cents)
			 VALUES (1, 't1', '2026-01-11', 'X', 200) RETURNING id`
		)
		.pluck()
		.get() as number;
	const link = db.prepare(
		"INSERT INTO split_payments (date, amount_cents, transaction_id) VALUES ('2026-01-11', 200, ?)"
	);
	link.run(txn);
	expect(() => link.run(txn)).toThrow(/UNIQUE/);
});
