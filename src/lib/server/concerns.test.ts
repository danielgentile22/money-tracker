import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import {
	upsertConcerns,
	expireConcerns,
	dismissConcern,
	activeConcerns,
	bucketFor,
	type ConcernCandidate
} from './concerns';

function makeDb() {
	const db = new Database(':memory:');
	migrate(db);
	return db;
}

const candidate = (over: Partial<ConcernCandidate> = {}): ConcernCandidate => ({
	detector: 'negative-cash-flow',
	subject: 'month',
	period: '2026-07',
	severity: 40,
	title: 'Spending exceeded income by $120.00 in July 2026',
	figures: { deficit_cents: 12_000 },
	txn_ids: [],
	...over
});

test('severity buckets: low / medium / high', () => {
	expect(bucketFor(0)).toBe('low');
	expect(bucketFor(33)).toBe('low');
	expect(bucketFor(34)).toBe('medium');
	expect(bucketFor(66)).toBe('medium');
	expect(bucketFor(67)).toBe('high');
	expect(bucketFor(100)).toBe('high');
});

test('same identity re-fire updates in place, never duplicates', () => {
	const db = makeDb();
	upsertConcerns(db, [candidate()]);
	upsertConcerns(db, [candidate({ severity: 55, figures: { deficit_cents: 30_000 } })]);

	const rows = activeConcerns(db);
	expect(rows).toHaveLength(1);
	expect(rows[0].severity).toBe(55);
	expect(JSON.parse(rows[0].figures)).toEqual({ deficit_cents: 30_000 });
});

test('dismissal hides; re-fire in the same bucket stays hidden; bucket rise resurrects', () => {
	const db = makeDb();
	upsertConcerns(db, [candidate({ severity: 40 })]); // medium
	dismissConcern(db, activeConcerns(db)[0].id);
	expect(activeConcerns(db)).toHaveLength(0);

	upsertConcerns(db, [candidate({ severity: 60 })]); // still medium → stays dismissed
	expect(activeConcerns(db)).toHaveLength(0);

	upsertConcerns(db, [candidate({ severity: 80 })]); // high > medium → back
	const rows = activeConcerns(db);
	expect(rows).toHaveLength(1);
	expect(rows[0].severity).toBe(80);
});

test('Concerns expire when their identity stops firing (period over, condition cleared)', () => {
	const db = makeDb();
	upsertConcerns(db, [
		candidate({ period: '2026-06' }), // last month's deficit
		candidate({ detector: 'fees', subject: 'txn:9', period: '2026-06-28', severity: 20 }),
		candidate({ period: '2026-07' })
	]);

	// July's run only re-fires the July identity
	expireConcerns(db, new Set(['negative-cash-flow:month:2026-07']));

	const active = activeConcerns(db);
	expect(active).toHaveLength(1);
	expect(active[0].period).toBe('2026-07');
});

test('ongoing Concerns expire when the condition clears, revive on a fresh episode', () => {
	const db = makeDb();
	const runway = candidate({ detector: 'runway', subject: 'account:1', period: 'ongoing' });
	upsertConcerns(db, [runway]);

	// condition persists: identity re-fired this run → stays active
	expireConcerns(db, new Set(['runway:account:1:ongoing']));
	expect(activeConcerns(db)).toHaveLength(1);

	// condition cleared: not in this run's candidates → expired
	expireConcerns(db, new Set());
	expect(activeConcerns(db)).toHaveLength(0);

	// fresh episode re-fires the same identity → active again (dismissal forgotten)
	upsertConcerns(db, [runway]);
	expect(activeConcerns(db)).toHaveLength(1);
});

test('feed ranks by severity, then recency', () => {
	const db = makeDb();
	upsertConcerns(db, [
		candidate({ subject: 'a', severity: 30 }),
		candidate({ subject: 'b', severity: 90 }),
		candidate({ subject: 'c', severity: 90 })
	]);
	db.prepare("UPDATE concerns SET updated_at = '2026-07-01 00:00:00' WHERE subject = 'b'").run();
	db.prepare("UPDATE concerns SET updated_at = '2026-07-04 00:00:00' WHERE subject = 'c'").run();

	expect(activeConcerns(db).map((c) => c.subject)).toEqual(['c', 'b', 'a']);
});

test('dismissConcern reports whether an active concern was hit', () => {
	const db = makeDb();
	upsertConcerns(db, [candidate({ severity: 40 })]);
	const id = activeConcerns(db)[0].id;
	expect(dismissConcern(db, id)).toBe(true);
	expect(dismissConcern(db, id)).toBe(false); // already dismissed
	expect(dismissConcern(db, 999)).toBe(false); // no such row
});
