import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import { detectRecurring, runRecurringDetection, type RecurringTxn } from './recurring';

let seq = 0;
const charge = (merchant: string, date: string, amount_cents: number): RecurringTxn => ({
	id: ++seq,
	merchant,
	date,
	amount_cents
});

const KNOBS = { amountTolerance: 0.2, dayTolerance: 3 };

test('three stable monthly charges form a monthly series', () => {
	const series = detectRecurring(
		[
			charge('netflix', '2026-04-15', -999),
			charge('netflix', '2026-05-15', -999),
			charge('netflix', '2026-06-15', -999)
		],
		KNOBS
	);
	expect(series).toEqual([
		{
			merchant: 'netflix',
			cadence: 'monthly',
			typical_amount_cents: 999,
			last_amount_cents: 999,
			first_seen: '2026-04-15',
			last_seen: '2026-06-15',
			member_ids: [1, 2, 3]
		}
	]);
});

test('a bill landing a day early or late still matches its cadence', () => {
	const series = detectRecurring(
		[
			charge('gym', '2026-03-01', -4_500),
			charge('gym', '2026-04-02', -4_500), // a day late
			charge('gym', '2026-04-30', -4_500), // two days early
			charge('gym', '2026-06-01', -4_500)
		],
		KNOBS
	);
	expect(series).toHaveLength(1);
	expect(series[0].cadence).toBe('monthly');
	expect(series[0].member_ids).toHaveLength(4);
});

test('amount tolerance: exactly ±20% of typical holds, historical outlier beyond breaks', () => {
	// 10_000 typical; 12_000 is exactly +20% → in
	const inTol = detectRecurring(
		[
			charge('hulu', '2026-03-10', -10_000),
			charge('hulu', '2026-04-10', -12_000),
			charge('hulu', '2026-05-10', -10_000),
			charge('hulu', '2026-06-10', -10_000)
		],
		KNOBS
	);
	expect(inTol).toHaveLength(1);
	expect(inTol[0].typical_amount_cents).toBe(10_000);

	// a historical (non-final) amount beyond tolerance → not a stable series
	const out = detectRecurring(
		[
			charge('hulu', '2026-03-10', -10_000),
			charge('hulu', '2026-04-10', -12_100),
			charge('hulu', '2026-05-10', -10_000),
			charge('hulu', '2026-06-10', -10_000)
		],
		KNOBS
	);
	expect(out).toHaveLength(0);
});

test('the LATEST amount may exceed tolerance and stay in the series — that drift is the creep signal', () => {
	const series = detectRecurring(
		[
			charge('netflix', '2026-03-15', -999),
			charge('netflix', '2026-04-15', -999),
			charge('netflix', '2026-05-15', -999),
			charge('netflix', '2026-06-15', -1_299) // +30% price hike
		],
		KNOBS
	);
	expect(series).toHaveLength(1);
	expect(series[0].typical_amount_cents).toBe(999);
	expect(series[0].last_amount_cents).toBe(1_299);
});

// #12: a price hike that persists for more than one bill must not drop the
// whole series (which would self-expire the subscription-creep concern).
test('a raised price held for two+ bills keeps the series alive', () => {
	const series = detectRecurring(
		[
			charge('netflix', '2026-03-15', -999),
			charge('netflix', '2026-04-15', -999),
			charge('netflix', '2026-05-15', -999),
			charge('netflix', '2026-06-15', -1_299), // +30%, and it sticks
			charge('netflix', '2026-07-15', -1_299)
		],
		KNOBS
	);
	expect(series).toHaveLength(1);
	expect(series[0].typical_amount_cents).toBe(999);
	expect(series[0].last_amount_cents).toBe(1_299);
});

// #12 (codex P1): once the new price is the MAJORITY the median flips to it —
// the series must still survive, with typical anchored to the old price so the
// creep detector keeps firing.
test('a raised price that becomes the majority keeps the series (typical stays old)', () => {
	const series = detectRecurring(
		[
			charge('netflix', '2026-01-15', -999),
			charge('netflix', '2026-02-15', -999),
			charge('netflix', '2026-03-15', -999),
			charge('netflix', '2026-04-15', -1_299),
			charge('netflix', '2026-05-15', -1_299),
			charge('netflix', '2026-06-15', -1_299),
			charge('netflix', '2026-07-15', -1_299) // 4 new vs 3 old → median is the new price
		],
		KNOBS
	);
	expect(series).toHaveLength(1);
	expect(series[0].typical_amount_cents).toBe(999);
	expect(series[0].last_amount_cents).toBe(1_299);
});

// A jump in the middle that then reverts is noise, not a clean step → dropped.
test('a one-off spike in the middle is still erratic', () => {
	const series = detectRecurring(
		[
			charge('gym', '2026-03-01', -4_500),
			charge('gym', '2026-04-01', -9_000), // spike
			charge('gym', '2026-05-01', -4_500),
			charge('gym', '2026-06-01', -4_500)
		],
		KNOBS
	);
	expect(series).toHaveLength(0);
});

test('annual series detected across leap-year-length gaps', () => {
	const series = detectRecurring(
		[
			charge('dropbox', '2024-06-20', -11_900),
			charge('dropbox', '2025-06-20', -11_900), // 365d
			charge('dropbox', '2026-06-21', -11_900) // 366d + a day late
		],
		KNOBS
	);
	expect(series).toHaveLength(1);
	expect(series[0].cadence).toBe('annual');
});

test('weekly series detected', () => {
	const series = detectRecurring(
		[
			charge('cleaner', '2026-06-01', -8_000),
			charge('cleaner', '2026-06-08', -8_000),
			charge('cleaner', '2026-06-15', -8_000)
		],
		KNOBS
	);
	expect(series).toHaveLength(1);
	expect(series[0].cadence).toBe('weekly');
});

// --- near-misses that must NOT be series ---

test('erratic gaps at the same Merchant are not a series', () => {
	expect(
		detectRecurring(
			[
				charge('bluebottle', '2026-06-01', -650),
				charge('bluebottle', '2026-06-03', -650),
				charge('bluebottle', '2026-06-20', -650),
				charge('bluebottle', '2026-06-24', -650)
			],
			KNOBS
		)
	).toHaveLength(0);
});

test('two occurrences are never a series; income is never a series', () => {
	expect(
		detectRecurring(
			[charge('gym', '2026-05-01', -4_500), charge('gym', '2026-06-01', -4_500)],
			KNOBS
		)
	).toHaveLength(0);
	expect(
		detectRecurring(
			[
				charge('employer', '2026-04-01', 500_000),
				charge('employer', '2026-05-01', 500_000),
				charge('employer', '2026-06-01', 500_000)
			],
			KNOBS
		)
	).toHaveLength(0);
});

// --- db integration: persistence, membership, knob overrides ---

function makeDb() {
	const db = new Database(':memory:');
	migrate(db);
	db.prepare("INSERT INTO connections (institution_name, plaid_item_id) VALUES ('B', 'i')").run();
	db.prepare(
		"INSERT INTO accounts (connection_id, plaid_account_id, name, type, subtype) VALUES (1, 'a1', 'Checking', 'depository', 'checking')"
	).run();
	return db;
}

let pidSeq = 0;
function insertCharge(
	db: Database.Database,
	merchant: string,
	date: string,
	amountCents: number,
	over: { is_transfer?: number; is_investment_activity?: number } = {}
) {
	db.prepare(
		`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, merchant, amount_cents, is_transfer, is_investment_activity)
		 VALUES (1, ?, ?, ?, ?, ?, ?, ?)`
	).run(`rp-${++pidSeq}`, date, merchant.toUpperCase(), merchant, amountCents, over.is_transfer ?? 0, over.is_investment_activity ?? 0);
}

test('detection persists series and membership; re-running is idempotent', () => {
	const db = makeDb();
	insertCharge(db, 'netflix', '2026-04-15', -999);
	insertCharge(db, 'netflix', '2026-05-15', -999);
	insertCharge(db, 'netflix', '2026-06-15', -999);
	insertCharge(db, 'one-off', '2026-06-01', -5_000);

	runRecurringDetection(db);
	runRecurringDetection(db);

	const series = db.prepare('SELECT * FROM recurring_series').all() as Record<string, unknown>[];
	expect(series).toHaveLength(1);
	expect(series[0]).toMatchObject({
		merchant: 'netflix',
		cadence: 'monthly',
		typical_amount_cents: 999,
		last_amount_cents: 999,
		first_seen: '2026-04-15',
		last_seen: '2026-06-15'
	});
	const members = db
		.prepare('SELECT COUNT(*) FROM transactions WHERE recurring_series_id IS NOT NULL')
		.pluck()
		.get();
	expect(members).toBe(3);
});

test('transfers and investment activity never join a series; knobs read from settings', () => {
	const db = makeDb();
	// would-be monthly series, but they are transfer legs (mortgage-style)
	insertCharge(db, 'transfer', '2026-04-01', -100_000, { is_transfer: 1 });
	insertCharge(db, 'transfer', '2026-05-01', -100_000, { is_transfer: 1 });
	insertCharge(db, 'transfer', '2026-06-01', -100_000, { is_transfer: 1 });
	// stable cadence, +25% wobble in history: out at default ±20%, in at 0.3
	insertCharge(db, 'gym', '2026-04-01', -10_000);
	insertCharge(db, 'gym', '2026-05-01', -12_500);
	insertCharge(db, 'gym', '2026-06-01', -10_000);
	insertCharge(db, 'gym', '2026-07-01', -10_000);

	runRecurringDetection(db);
	expect(db.prepare('SELECT COUNT(*) FROM recurring_series').pluck().get()).toBe(0);

	db.prepare("INSERT INTO settings (key, value) VALUES ('recurring_amount_tolerance', '0.3')").run();
	runRecurringDetection(db);
	const merchants = db.prepare('SELECT merchant FROM recurring_series').pluck().all();
	expect(merchants).toEqual(['gym']);
});

test('wild amounts at a stable cadence are not a series', () => {
	expect(
		detectRecurring(
			[
				charge('amazon', '2026-04-05', -1_250),
				charge('amazon', '2026-05-05', -18_900),
				charge('amazon', '2026-06-05', -4_400),
				charge('amazon', '2026-07-05', -700)
			],
			KNOBS
		)
	).toHaveLength(0);
});

test('a muted merchant is skipped by detection entirely', () => {
	const db = makeDb();
	insertCharge(db, 'trader joes', '2026-04-15', -8_000);
	insertCharge(db, 'trader joes', '2026-05-15', -8_000);
	insertCharge(db, 'trader joes', '2026-06-15', -8_000);
	db.prepare("INSERT INTO muted_merchants (merchant) VALUES ('trader joes')").run();

	runRecurringDetection(db);

	expect(db.prepare('SELECT COUNT(*) FROM recurring_series').pluck().get()).toBe(0);
	expect(
		db.prepare('SELECT COUNT(*) FROM transactions WHERE recurring_series_id IS NOT NULL').pluck().get()
	).toBe(0);
});
