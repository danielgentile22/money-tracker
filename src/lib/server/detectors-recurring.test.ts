import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import { runRecurringDetection } from './recurring';
import { runDetectors } from './detectors';
import { activeConcerns } from './concerns';

const TODAY = '2026-07-15';

function makeDb() {
	const db = new Database(':memory:');
	migrate(db);
	db.prepare("INSERT INTO connections (institution_name, plaid_item_id) VALUES ('B', 'i')").run();
	db.prepare(
		`INSERT INTO accounts (connection_id, plaid_account_id, name, type, subtype, current_balance_cents)
		 VALUES (1, 'a1', 'Checking', 'depository', 'checking', 1_000_000)`
	).run();
	return db;
}

let seq = 0;
function charge(db: Database.Database, merchant: string, date: string, amountCents: number) {
	db.prepare(
		`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, merchant, amount_cents)
		 VALUES (1, ?, ?, ?, ?, ?)`
	).run(`rd-${++seq}`, date, merchant.toUpperCase(), merchant, amountCents);
}

function run(db: Database.Database) {
	runRecurringDetection(db);
	runDetectors(db, TODAY);
}

const byDetector = (db: Database.Database, key: string) =>
	activeConcerns(db).filter((c) => c.detector === key);

// --- new recurring charge ---

test('a series that crystallizes this month fires new-recurring; an established one does not', () => {
	const db = makeDb();
	// weekly series: 3rd occurrence lands July 13 → crystallized this month
	charge(db, 'cleaner', '2026-06-29', -8_000);
	charge(db, 'cleaner', '2026-07-06', -8_000);
	charge(db, 'cleaner', '2026-07-13', -8_000);
	// established monthly series: 3rd occurrence was June 15
	charge(db, 'netflix', '2026-04-15', -999);
	charge(db, 'netflix', '2026-05-15', -999);
	charge(db, 'netflix', '2026-06-15', -999);
	charge(db, 'netflix', '2026-07-15', -999);

	run(db);
	run(db); // re-fire updates, never duplicates

	const fired = byDetector(db, 'new-recurring');
	expect(fired).toHaveLength(1);
	expect(fired[0].subject).toBe('merchant:cleaner');
	expect(JSON.parse(fired[0].figures)).toMatchObject({ cadence: 'weekly', typical_cents: 8_000 });
});

// --- subscription creep ---

test('a +30% latest bill fires creep with old → new; +15% stays inside tolerance', () => {
	const db = makeDb();
	charge(db, 'netflix', '2026-04-15', -999);
	charge(db, 'netflix', '2026-05-15', -999);
	charge(db, 'netflix', '2026-06-15', -999);
	charge(db, 'netflix', '2026-07-15', -1_299);
	charge(db, 'hulu', '2026-04-10', -1_000);
	charge(db, 'hulu', '2026-05-10', -1_000);
	charge(db, 'hulu', '2026-06-10', -1_000);
	charge(db, 'hulu', '2026-07-10', -1_149);

	run(db);

	const fired = byDetector(db, 'subscription-creep');
	expect(fired).toHaveLength(1);
	expect(fired[0].subject).toBe('merchant:netflix');
	expect(JSON.parse(fired[0].figures)).toMatchObject({ old_cents: 999, new_cents: 1_299 });
	expect(fired[0].title).toContain('$9.99');
	expect(fired[0].title).toContain('$12.99');
});

// --- duplicate charge ---

test('a genuine double-tap fires; a gap beyond the window does not', () => {
	const db = makeDb();
	charge(db, 'gym', '2026-07-10', -4_500);
	charge(db, 'gym', '2026-07-12', -4_500);
	charge(db, 'spa', '2026-07-05', -4_500);
	charge(db, 'spa', '2026-07-12', -4_500); // 7 days apart

	run(db);

	const fired = byDetector(db, 'duplicate-charge');
	expect(fired).toHaveLength(1);
	expect(fired[0].subject).toContain('gym');
	expect(JSON.parse(fired[0].txn_ids)).toHaveLength(2);
});

test('a recurring bill is never a duplicate, even inside a widened window', () => {
	const db = makeDb();
	db.prepare("INSERT INTO settings (key, value) VALUES ('detector_duplicate-charge_window', '7')").run();
	// weekly series: members 7 days apart would pair under the widened window
	charge(db, 'cleaner', '2026-06-29', -8_000);
	charge(db, 'cleaner', '2026-07-06', -8_000);
	charge(db, 'cleaner', '2026-07-13', -8_000);

	run(db);

	expect(byDetector(db, 'duplicate-charge')).toHaveLength(0);
});
