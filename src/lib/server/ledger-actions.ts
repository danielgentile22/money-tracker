import type { Database } from 'better-sqlite3';
import { db as defaultDb } from '$lib/server/db';
import { formId } from '$lib/server/form-id';
import { applyCorrection, applyBulkCorrection } from '$lib/server/corrections';
import { addTag, attachTag, detachTag, bulkAttach } from '$lib/server/tags';
import { triggerLookup, enrichAndCategorize } from '$lib/server/resolution';
import { runLookupBatch, hasConnectedInbox } from '$lib/server/backfill';
import { realReceiptSource } from '$lib/server/gmail';
import { realLlm } from '$lib/server/llm';
import { fail, type Actions } from '@sveltejs/kit';

/**
 * The Ledger's form actions (CONTEXT.md: the one surface that lists
 * Transactions). Any route that mounts Ledger.svelte spreads these in —
 * same pattern as savedReportActions. Returns are inferred (satisfies, not a
 * plain Actions annotation) so each route's ActionData keeps message/lookup.
 * db is injectable so the parsing/validation layer is testable (#37).
 */
export function ledgerActions(db: Database = defaultDb) {
	return {
		correct: async ({ request }) => {
			const f = await request.formData();
			const id = Number(f.get('id'));
			const newCategoryName = (f.get('new_category') as string)?.trim();
			const categoryId = Number(f.get('category_id')) || undefined;
			if (!id || (!categoryId && !newCategoryName)) return fail(400, { message: 'pick a Category' });
			const tagName = (f.get('tag') as string)?.trim();
			applyCorrection(db, id, {
				categoryId,
				newCategoryName: newCategoryName || undefined,
				applyToFuture: f.get('apply_future') === 'on',
				tagIds: tagName ? [addTag(db, tagName)] : []
			});
			return { ok: true };
		},
		// Tag chips in the ledger (stories 17–18): free text creates inline
		tag: async ({ request }) => {
			const f = await request.formData();
			const name = (f.get('name') as string)?.trim();
			if (!name) return fail(400, { message: 'type a Tag name' });
			attachTag(db, Number(f.get('id')), addTag(db, name));
			return { ok: true };
		},
		untag: async ({ request }) => {
			const f = await request.formData();
			const id = formId(f);
			const tagId = formId(f, 'tag_id');
			if (id == null || tagId == null || !detachTag(db, id, tagId))
				return fail(400, { message: 'no such Tag on that Transaction' });
			return { ok: true };
		},
		// bulk Correction (CONTEXT.md): one Category over the selection, never mints a Rule
		bulkCorrect: async ({ request }) => {
			const f = await request.formData();
			const ids = f.getAll('ids').map(Number).filter(Boolean);
			const categoryId = Number(f.get('category_id'));
			if (ids.length === 0) return fail(400, { message: 'select Transactions first' });
			if (!categoryId) return fail(400, { message: 'pick a Category' });
			applyBulkCorrection(db, ids, categoryId);
			return { ok: true };
		},
		// bulk untag by name: detaches only where attached, never creates the Tag
		bulkUntag: async ({ request }) => {
			const f = await request.formData();
			const ids = f.getAll('ids').map(Number).filter(Boolean);
			const name = (f.get('name') as string)?.trim();
			if (ids.length === 0) return fail(400, { message: 'select Transactions first' });
			const tagId = db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE').pluck().get(name) as
				| number
				| undefined;
			if (!tagId) return fail(400, { message: `no Tag named “${name}”` });
			for (const id of ids) detachTag(db, id, tagId);
			return { ok: true };
		},
		// bulk receipt search over the selection — same background batch as lookupAll
		bulkLookup: async ({ request }) => {
			const f = await request.formData();
			const ids = f.getAll('ids').map(Number).filter(Boolean);
			if (ids.length === 0) return fail(400, { message: 'select Transactions first' });
			if (!hasConnectedInbox(db))
				return fail(400, { message: 'no connected inbox — re-enroll Gmail in Settings' });
			void runLookupBatch(db, realReceiptSource, realLlm, ids).catch((e) =>
				console.error('bulk lookup failed:', e)
			);
			return { ok: true, started: ids.length };
		},
		// multi-select bulk tagging (story 19)
		bulkTag: async ({ request }) => {
			const f = await request.formData();
			const ids = f.getAll('ids').map(Number).filter(Boolean);
			const name = (f.get('name') as string)?.trim();
			if (ids.length === 0) return fail(400, { message: 'select Transactions first' });
			if (!name) return fail(400, { message: 'type a Tag name' });
			bulkAttach(db, ids, addTag(db, name));
			return { ok: true };
		},
		// story 17: manual receipt lookup on any Transaction
		lookup: async ({ request }) => {
			const f = await request.formData();
			try {
				const id = Number(f.get('id'));
				const outcome = await triggerLookup(db, realReceiptSource, id);
				// a manual match enriches and re-categorizes right away, no sync wait
				if (outcome === 'matched') await enrichAndCategorize(db, realLlm, [id]).catch(() => {});
				return { ok: true, lookup: outcome };
			} catch (e) {
				return fail(400, { message: e instanceof Error ? e.message : String(e) });
			}
		}
	} satisfies Actions;
}
