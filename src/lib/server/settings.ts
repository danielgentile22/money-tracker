import type { Database } from 'better-sqlite3';

// One reader/writer pair for the settings key-value table (#83) — instead of
// raw SQL re-typed per module. Migrate call sites opportunistically as files
// are touched.

export function getSetting(db: Database, key: string): string | undefined {
	return db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as
		| string
		| undefined;
}

export function putSetting(db: Database, key: string, value: string): void {
	db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

export function deleteSetting(db: Database, key: string): void {
	db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}
