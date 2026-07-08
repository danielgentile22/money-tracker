import { db } from '$lib/server/db';
import { parseFilters, serializeFilters, type DatePreset } from '$lib/server/filters';
import { saveReport, renameReport, deleteReport } from '$lib/server/saved-reports';
import { fail, type Actions } from '@sveltejs/kit';

/** /reports' form actions (sole consumer since slice 5): a saved report is a name on a canonical URL. */
export function savedReportActions(path: string, defaultPreset: DatePreset): Actions {
	return {
		saveReport: async ({ request }) => {
			const form = await request.formData();
			const name = (form.get('name') as string)?.trim();
			if (!name) return fail(400, { message: 'name the view first' });
			const raw = new URLSearchParams((form.get('query') as string) ?? '');
			// canonicalize: filters through parse→serialize, page params appended
			const q = new URLSearchParams(serializeFilters(parseFilters(raw, defaultPreset)));
			for (const k of ['tab', 'by']) if (raw.get(k)) q.set(k, raw.get(k)!);
			saveReport(db, name, { path, query: q.toString() });
			return { ok: true };
		},
		renameReport: async ({ request }) => {
			const form = await request.formData();
			try {
				renameReport(db, Number(form.get('id')), (form.get('name') as string) ?? '');
			} catch (e) {
				return fail(400, { message: e instanceof Error ? e.message : String(e) });
			}
			return { ok: true };
		},
		deleteReport: async ({ request }) => {
			const form = await request.formData();
			deleteReport(db, Number(form.get('id')));
			return { ok: true };
		}
	};
}
