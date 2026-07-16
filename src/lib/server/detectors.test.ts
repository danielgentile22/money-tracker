import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import { runDetectors, DETECTORS } from './detectors';
import { activeConcerns } from './concerns';

const TODAY = '2026-07-04';

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
function insert(
	db: Database.Database,
	over: {
		date?: string;
		amount_cents: number;
		merchant?: string;
		category?: string;
		is_transfer?: number;
		recurring?: boolean;
	}
) {
	const id = db
		.prepare(
			`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, merchant, amount_cents, category_id, is_transfer)
			 VALUES (1, ?, ?, 'FX', ?, ?, (SELECT id FROM categories WHERE name = ?), ?) RETURNING id`
		)
		.pluck()
		.get(
			`dx-${++seq}`,
			over.date ?? '2026-07-02',
			over.merchant ?? 'merchant',
			over.amount_cents,
			over.category ?? null,
			over.is_transfer ?? 0
		) as number;
	if (over.recurring) {
		db.prepare(
			`INSERT INTO recurring_series (merchant, cadence, typical_amount_cents, last_amount_cents, first_seen, last_seen)
			 VALUES (?, 'monthly', ?, ?, '2026-01-01', ?)`
		).run(over.merchant ?? 'merchant', -over.amount_cents, -over.amount_cents, over.date ?? '2026-07-02');
		db.prepare('UPDATE transactions SET recurring_series_id = last_insert_rowid() WHERE id = ?').run(id);
	}
	return id;
}

const byDetector = (db: Database.Database, key: string) =>
	activeConcerns(db).filter((c) => c.detector === key);

// --- fees & interest ---

test('a fee Transaction raises one Concern; ordinary spending does not', () => {
	const db = makeDb();
	const fee = insert(db, { amount_cents: -3_500, category: 'Fees', merchant: 'bank' });
	insert(db, { amount_cents: -3_500, category: 'Dining' });
	insert(db, { amount_cents: -1_200, category: 'Interest', merchant: 'bank', date: '2026-07-03' });

	runDetectors(db, TODAY);

	const fired = byDetector(db, 'fees-interest');
	expect(fired).toHaveLength(2);
	expect(JSON.parse(fired.find((c) => c.subject === `txn:${fee}`)!.txn_ids)).toEqual([fee]);
});

test('fee severity rises with amount', () => {
	const db = makeDb();
	insert(db, { amount_cents: -500, category: 'Fees', date: '2026-07-01' });
	insert(db, { amount_cents: -9_000, category: 'Fees', date: '2026-07-02' });
	runDetectors(db, TODAY);
	const [small, big] = byDetector(db, 'fees-interest').sort((a, b) => a.severity - b.severity);
	expect(small.severity).toBeLessThan(big.severity);
});

// #13: a month-end fee synced after rollover (dated last month, arriving this
// month) must still fire — the trailing window covers it, the old calendar-month
// filter dropped it.
test('a fee dated late last month still fires after rollover', () => {
	const db = makeDb();
	const fee = insert(db, { amount_cents: -3_500, category: 'Fees', merchant: 'bank', date: '2026-06-30' });
	runDetectors(db, TODAY); // TODAY = 2026-07-04
	const fired = byDetector(db, 'fees-interest');
	expect(fired).toHaveLength(1);
	expect(fired[0].subject).toBe(`txn:${fee}`);
});

// --- large one-off ---

test('large one-off fires at the $500 default floor; a just-below twin does not', () => {
	const db = makeDb();
	const big = insert(db, { amount_cents: -50_000, category: 'Shopping', merchant: 'apple' });
	insert(db, { amount_cents: -49_900, category: 'Shopping', merchant: 'apple2' });

	runDetectors(db, TODAY);

	const fired = byDetector(db, 'large-one-off');
	expect(fired).toHaveLength(1);
	expect(fired[0].subject).toBe(`txn:${big}`);
});

test('recurring-series members and Transfers never fire large one-off', () => {
	const db = makeDb();
	insert(db, { amount_cents: -80_000, merchant: 'rent co', category: 'Home', recurring: true });
	insert(db, { amount_cents: -80_000, is_transfer: 1 });
	runDetectors(db, TODAY);
	expect(byDetector(db, 'large-one-off')).toHaveLength(0);
});

test('knob override respected: floor raised to $1000 silences a $600 charge', () => {
	const db = makeDb();
	db.prepare("INSERT INTO settings (key, value) VALUES ('detector_large-one-off_floor', '1000')").run();
	insert(db, { amount_cents: -60_000, category: 'Shopping' });
	runDetectors(db, TODAY);
	expect(byDetector(db, 'large-one-off')).toHaveLength(0);
});

test('a disabled Detector never fires', () => {
	const db = makeDb();
	db.prepare("INSERT INTO settings (key, value) VALUES ('detector_large-one-off_enabled', '0')").run();
	insert(db, { amount_cents: -90_000, category: 'Shopping' });
	runDetectors(db, TODAY);
	expect(byDetector(db, 'large-one-off')).toHaveLength(0);
});

// --- negative cash flow ---

test('negative month cash flow raises one month-scoped Concern; positive month stays quiet', () => {
	const db = makeDb();
	insert(db, { amount_cents: 100_000, category: 'Income', date: '2026-07-01' });
	insert(db, { amount_cents: -130_000, category: 'Home', date: '2026-07-02' });
	runDetectors(db, TODAY);
	const fired = byDetector(db, 'negative-cash-flow');
	expect(fired).toHaveLength(1);
	expect(fired[0].period).toBe('2026-07');
	expect(JSON.parse(fired[0].figures)).toMatchObject({ deficit_cents: 30_000 });

	// income catches up: same identity updates and the Concern clears at zero+
	insert(db, { amount_cents: 50_000, category: 'Income', date: '2026-07-03' });
	runDetectors(db, TODAY);
	expect(byDetector(db, 'negative-cash-flow')).toHaveLength(0);
});

test('severity is monotonic in deficit magnitude', () => {
	const run = (spend: number) => {
		const db = makeDb();
		insert(db, { amount_cents: 100_000, category: 'Income', date: '2026-07-01' });
		insert(db, { amount_cents: spend, category: 'Home', date: '2026-07-02' });
		runDetectors(db, TODAY);
		return byDetector(db, 'negative-cash-flow')[0].severity;
	};
	expect(run(-110_000)).toBeLessThan(run(-160_000));
	expect(run(-160_000)).toBeLessThan(run(-300_000));
});

// --- registry sanity ---

test('every Detector declares key, label, and knob defaults', () => {
	for (const d of DETECTORS) {
		expect(d.key).toBeTruthy();
		expect(d.label).toBeTruthy();
		for (const k of d.knobs) expect(typeof k.default).toBe('number');
	}
});
