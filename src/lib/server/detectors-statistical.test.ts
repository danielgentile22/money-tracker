import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import { runDetectors } from './detectors';
import { activeConcerns } from './concerns';

const TODAY = '2026-07-15';

function makeDb() {
	const db = new Database(':memory:');
	migrate(db);
	db.prepare("INSERT INTO connections (institution_name, plaid_item_id) VALUES ('B', 'i')").run();
	db.prepare(
		`INSERT INTO accounts (connection_id, plaid_account_id, name, type, subtype, current_balance_cents)
		 VALUES (1, 'a1', 'Checking', 'depository', 'checking', 90_000)`
	).run();
	return db;
}

let seq = 0;
function insert(
	db: Database.Database,
	date: string,
	amount_cents: number,
	over: { category?: string; is_transfer?: number; is_saved?: number } = {}
) {
	db.prepare(
		`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, merchant, amount_cents, category_id, is_transfer, is_saved)
		 VALUES (1, ?, ?, 'FX', 'fx', ?, (SELECT id FROM categories WHERE name = ?), ?, ?)`
	).run(`sx-${++seq}`, date, amount_cents, over.category ?? null, over.is_transfer ?? 0, over.is_saved ?? 0);
}

/**
 * Baseline: Mar–Jun history of steady income, dining, savings. Data starts
 * mid-March, so Apr/May/Jun are the 3 countable full months — exactly at the
 * Detectors' minimum, and the same window their trailing averages read.
 */
function seedHistory(db: Database.Database, opts: { dining?: number; saved?: number } = {}) {
	for (const m of ['2026-03', '2026-04', '2026-05', '2026-06']) {
		insert(db, `${m}-01`, 500_000, { category: 'Income' });
		insert(db, `${m}-10`, -(opts.dining ?? 20_000), { category: 'Dining' });
		insert(db, `${m}-12`, -(opts.saved ?? 100_000), { is_transfer: 1, is_saved: 1 });
	}
	// keep the current month's cash flow positive so negative-cash-flow stays out of the way
	insert(db, '2026-07-01', 500_000, { category: 'Income' });
}

const byDetector = (db: Database.Database, key: string) =>
	activeConcerns(db).filter((c) => c.detector === key);

// --- spend spike ---

test('spend spike fires at 1.5× trailing average above the $50 floor; 1.4× twin stays silent', () => {
	const db = makeDb();
	seedHistory(db); // dining avg $200/mo
	insert(db, '2026-07-08', -31_000, { category: 'Dining' }); // 1.55×
	runDetectors(db, TODAY);
	const fired = byDetector(db, 'spend-spike');
	expect(fired).toHaveLength(1);
	expect(fired[0].period).toBe('2026-07');
	expect(JSON.parse(fired[0].figures)).toMatchObject({ mtd_cents: 31_000, avg_cents: 20_000 });

	const db2 = makeDb();
	seedHistory(db2);
	insert(db2, '2026-07-08', -28_000, { category: 'Dining' }); // 1.4×
	runDetectors(db2, TODAY);
	expect(byDetector(db2, 'spend-spike')).toHaveLength(0);
});

test('spend spike respects the $ floor: tiny categories never spike', () => {
	const db = makeDb();
	seedHistory(db);
	for (const m of ['2026-04', '2026-05', '2026-06']) insert(db, `${m}-05`, -1_000, { category: 'Coffee' });
	// (Coffee avg $10/mo over the Apr–Jun window)
	insert(db, '2026-07-05', -4_000, { category: 'Coffee' }); // 4× avg but only $40 MTD
	runDetectors(db, TODAY);
	expect(byDetector(db, 'spend-spike')).toHaveLength(0);
});

test('spike severity is monotonic in the ratio', () => {
	const sev = (mtd: number) => {
		const db = makeDb();
		seedHistory(db);
		insert(db, '2026-07-08', -mtd, { category: 'Dining' });
		runDetectors(db, TODAY);
		return byDetector(db, 'spend-spike')[0].severity;
	};
	expect(sev(32_000)).toBeLessThan(sev(50_000));
	expect(sev(50_000)).toBeLessThan(sev(90_000));
});

// --- savings-rate drop ---

test('savings-rate drop fires below 75% of trailing average; a shallower dip stays silent', () => {
	const db = makeDb();
	seedHistory(db); // trailing rate 20% each month
	insert(db, '2026-07-10', -70_000, { is_transfer: 1, is_saved: 1 }); // 14% < 15% (75% of 20%)
	runDetectors(db, TODAY);
	const fired = byDetector(db, 'savings-rate-drop');
	expect(fired).toHaveLength(1);

	const db2 = makeDb();
	seedHistory(db2);
	insert(db2, '2026-07-10', -80_000, { is_transfer: 1, is_saved: 1 }); // 16% > 15%
	runDetectors(db2, TODAY);
	expect(byDetector(db2, 'savings-rate-drop')).toHaveLength(0);
});

test('savings-rate-drop severity grows as the rate falls further', () => {
	const sev = (savedCents: number) => {
		const db = makeDb();
		seedHistory(db);
		if (savedCents > 0) insert(db, '2026-07-10', -savedCents, { is_transfer: 1, is_saved: 1 });
		runDetectors(db, TODAY);
		return byDetector(db, 'savings-rate-drop')[0].severity;
	};
	expect(sev(70_000)).toBeLessThan(sev(30_000));
	expect(sev(30_000)).toBeLessThan(sev(0));
});

// --- low-balance runway ---

test('runway fires as ongoing when burn projects dry inside the horizon, silent when safe', () => {
	const db = makeDb();
	seedHistory(db);
	// June 15 → July 15 window nets −$4,500 (incl. July's +$5,000 income):
	// $150/day burn on a $900 balance ⇒ ~6 days
	insert(db, '2026-06-20', -200_000, { category: 'Home' });
	insert(db, '2026-07-05', -750_000, { category: 'Home' });
	runDetectors(db, TODAY);
	const fired = byDetector(db, 'low-balance-runway');
	expect(fired).toHaveLength(1);
	expect(fired[0].period).toBe('ongoing');

	// balance recovers → condition clears on the next run
	db.prepare('UPDATE accounts SET current_balance_cents = 100_000_000 WHERE id = 1').run();
	runDetectors(db, TODAY);
	expect(byDetector(db, 'low-balance-runway')).toHaveLength(0);
});

test('positive trailing flow never fires runway', () => {
	const db = makeDb();
	seedHistory(db); // July has income only ⇒ net positive last 30 days
	runDetectors(db, TODAY);
	expect(byDetector(db, 'low-balance-runway')).toHaveLength(0);
});

// --- insufficient history ---

test('spike and rate-drop stay silent below 3 full months of history', () => {
	const db = makeDb();
	// only June exists (1 full month) with a screaming spike in July
	insert(db, '2026-06-01', 500_000, { category: 'Income' });
	insert(db, '2026-06-10', -20_000, { category: 'Dining' });
	insert(db, '2026-06-12', -100_000, { is_transfer: 1, is_saved: 1 });
	insert(db, '2026-07-01', 500_000, { category: 'Income' });
	insert(db, '2026-07-08', -90_000, { category: 'Dining' });
	runDetectors(db, TODAY);
	expect(byDetector(db, 'spend-spike')).toHaveLength(0);
	expect(byDetector(db, 'savings-rate-drop')).toHaveLength(0);
});
