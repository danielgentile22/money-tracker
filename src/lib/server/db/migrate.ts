import type { Database } from 'better-sqlite3';

// Bundled at build time so migrations work in dev, build, and tests alike.
const migrations = Object.entries(
	import.meta.glob('./migrations/*.sql', { query: '?raw', eager: true, import: 'default' })
).sort(([a], [b]) => a.localeCompare(b)) as [string, string][];

/** upTo lets migration tests stop before a version, seed data, then finish. */
export function migrate(db: Database, upTo = Infinity): void {
	const applied = db.pragma('user_version', { simple: true }) as number;
	migrations.forEach(([, sql], i) => {
		const version = i + 1;
		if (version <= applied || version > upTo) return;
		db.transaction(() => {
			db.exec(sql);
			db.pragma(`user_version = ${version}`);
		})();
	});
}
