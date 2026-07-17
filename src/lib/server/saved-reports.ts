import type { Database } from 'better-sqlite3';

// A saved report is a bookmark: a name on a page path + canonical query
// string. Date presets ride along as presets ("this year" stays relative);
// custom ranges are absolute from/to params. Nothing here re-interprets the
// config — the page's load function parses it like any other URL.

export type SavedReportConfig = { path: string; query: string };
export type SavedReport = { id: number; name: string; created_at: string } & SavedReportConfig;

function rowToReport(r: { id: number; name: string; config: string; created_at: string }): SavedReport {
	const { path, query } = JSON.parse(r.config) as SavedReportConfig;
	return { id: r.id, name: r.name, created_at: r.created_at, path, query };
}

export function saveReport(db: Database, name: string, config: SavedReportConfig): number {
	const n = name.trim();
	if (!n) throw new Error('name required');
	return db
		.prepare(
			`INSERT INTO saved_reports (name, config) VALUES (?, ?)
			 ON CONFLICT (name) DO UPDATE SET config = excluded.config RETURNING id`
		)
		.pluck()
		.get(n, JSON.stringify(config)) as number;
}

/** Saved reports for one page (or all), newest first. */
export function listReports(db: Database, path?: string): SavedReport[] {
	const all = (
		db
			.prepare('SELECT id, name, config, created_at FROM saved_reports ORDER BY created_at DESC, id DESC')
			.all() as { id: number; name: string; config: string; created_at: string }[]
	).map(rowToReport);
	return path ? all.filter((r) => r.path === path) : all;
}

export function getReport(db: Database, id: number): SavedReport | null {
	const r = db
		.prepare('SELECT id, name, config, created_at FROM saved_reports WHERE id = ?')
		.get(id) as { id: number; name: string; config: string; created_at: string } | undefined;
	return r ? rowToReport(r) : null;
}

export function renameReport(db: Database, id: number, newName: string): void {
	const name = newName.trim();
	if (!name) throw new Error('name required');
	if (db.prepare('UPDATE saved_reports SET name = ? WHERE id = ?').run(name, id).changes === 0)
		throw new Error('no such saved report');
}

/** True when a row was actually deleted — stale-tab deletes must not report success. */
export function deleteReport(db: Database, id: number): boolean {
	return db.prepare('DELETE FROM saved_reports WHERE id = ?').run(id).changes > 0;
}
