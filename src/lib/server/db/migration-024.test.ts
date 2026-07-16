import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './migrate';

// Migration 024 (#14): a 529's stored "age today" becomes a birth year, so the
// college year stops drifting a year every calendar year. Conversion uses the
// current year at migration time (the age was entered ~now).

test('529 age settings convert to a birth year; the old key is removed', () => {
	const db = new Database(':memory:');
	migrate(db, 23); // pre-conversion world
	db.prepare("INSERT INTO settings (key, value) VALUES ('529_2_age', '10')").run();
	db.prepare("INSERT INTO settings (key, value) VALUES ('529_5_age', '16')").run();
	db.prepare("INSERT INTO settings (key, value) VALUES ('assumed_return_pct', '6')").run(); // untouched

	migrate(db);

	const val = (key: string) =>
		db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as string | undefined;
	const thisYear = new Date().getFullYear();
	expect(val('529_2_birth_year')).toBe(String(thisYear - 10));
	expect(val('529_5_birth_year')).toBe(String(thisYear - 16));
	expect(val('529_2_age')).toBeUndefined();
	expect(val('529_5_age')).toBeUndefined();
	expect(val('assumed_return_pct')).toBe('6'); // unrelated setting survives
});
