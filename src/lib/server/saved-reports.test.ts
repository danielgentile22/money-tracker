import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import { saveReport, listReports, getReport, renameReport, deleteReport } from './saved-reports';
import { parseFilters, serializeFilters } from './filters';

function makeDb() {
	const db = new Database(':memory:');
	migrate(db);
	return db;
}

test('save / list / rename / delete round-trip', () => {
	const db = makeDb();
	const id = saveReport(db, 'Dining this year', {
		path: '/reports',
		query: 'tab=spending&by=category&categories=3&date=ytd'
	});
	expect(listReports(db, '/reports')).toHaveLength(1);
	expect(listReports(db, '/cash-flow')).toHaveLength(0);
	expect(getReport(db, id)).toMatchObject({
		name: 'Dining this year',
		path: '/reports',
		query: 'tab=spending&by=category&categories=3&date=ytd'
	});

	renameReport(db, id, 'Dining YTD');
	expect(getReport(db, id)?.name).toBe('Dining YTD');

	deleteReport(db, id);
	expect(listReports(db)).toHaveLength(0);
});

test('saving an existing name overwrites its config (a bookmark, not a duplicate)', () => {
	const db = makeDb();
	const a = saveReport(db, 'View', { path: '/reports', query: 'date=ytd' });
	const b = saveReport(db, 'view', { path: '/reports', query: 'date=all' }); // NOCASE
	expect(b).toBe(a);
	expect(getReport(db, a)?.query).toBe('date=all');
});

test('relative presets survive save/load as presets; custom ranges as absolute dates', () => {
	const db = makeDb();
	const preset = serializeFilters(parseFilters(new URLSearchParams('date=ytd&categories=3')));
	const custom = serializeFilters(
		parseFilters(new URLSearchParams('from=2026-01-05&to=2026-02-10'))
	);
	const pid = saveReport(db, 'preset', { path: '/reports', query: preset });
	const cid = saveReport(db, 'custom', { path: '/reports', query: custom });

	const reopened = parseFilters(new URLSearchParams(getReport(db, pid)!.query));
	expect(reopened.date).toEqual({ preset: 'ytd' }); // re-resolves against the new today
	const reopenedCustom = parseFilters(new URLSearchParams(getReport(db, cid)!.query));
	expect(reopenedCustom.date).toEqual({ from: '2026-01-05', to: '2026-02-10' });

	// config round-trips through serialization unchanged
	expect(serializeFilters(reopened)).toBe(preset);
	expect(serializeFilters(reopenedCustom)).toBe(custom);
});

test('rename/delete on a stale id fail loudly instead of no-op success', () => {
	const db = makeDb();
	expect(deleteReport(db, 999)).toBe(false);
	expect(() => renameReport(db, 999, 'Ghost')).toThrow('no such saved report');
	const id = saveReport(db, 'Real', { path: '/reports', query: 'date=ytd' });
	expect(deleteReport(db, id)).toBe(true);
});
