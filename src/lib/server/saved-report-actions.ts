import type { Database } from 'better-sqlite3';
import { db as defaultDb } from '$lib/server/db';
import { formId } from '$lib/server/form-id';
import { parseFilters, serializeFilters, type DatePreset } from '$lib/server/filters';
import { saveReport, renameReport, deleteReport } from '$lib/server/saved-reports';
import { fail, type Actions } from '@sveltejs/kit';

/**
 * Form actions for pages with saved reports: a saved report is a name on a
 * canonical URL. `pageKeys` are the page-local params (outside the filter
 * grammar) a saved view keeps: /reports has tab/by, /transactions min/max.
 * db is injectable for tests (#37); returns are inferred via satisfies so the
 * route's form prop keeps its fields.
 */
export function savedReportActions(
	path: string,
	defaultPreset: DatePreset,
	pageKeys: string[] = ['tab', 'by'],
	db: Database = defaultDb
) {
	return {
		saveReport: async ({ request }) => {
			const form = await request.formData();
			const name = (form.get('name') as string)?.trim();
			if (!name) return fail(400, { message: 'name the view first' });
			const raw = new URLSearchParams((form.get('query') as string) ?? '');
			// canonicalize: filters through parse→serialize, page params appended
			const q = new URLSearchParams(serializeFilters(parseFilters(raw, defaultPreset)));
			for (const k of pageKeys) if (raw.get(k)) q.set(k, raw.get(k)!);
			saveReport(db, name, { path, query: q.toString() });
			return { ok: true };
		},
		renameReport: async ({ request }) => {
			const form = await request.formData();
			const id = formId(form);
			if (id == null) return fail(400, { message: 'no such saved report' });
			try {
				renameReport(db, id, (form.get('name') as string) ?? '');
			} catch (e) {
				return fail(400, { message: e instanceof Error ? e.message : String(e) });
			}
			return { ok: true };
		},
		deleteReport: async ({ request }) => {
			const form = await request.formData();
			const id = formId(form);
			if (id == null || !deleteReport(db, id))
				return fail(400, { message: 'no such saved report' });
			return { ok: true };
		}
	} satisfies Actions;
}
