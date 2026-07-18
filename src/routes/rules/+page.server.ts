import { db } from '$lib/server/db';
import { formId } from '$lib/server/form-id';
import { updateRule, deleteRule } from '$lib/server/corrections';
import { groupedCategories } from '$lib/server/groups';
import { addTag } from '$lib/server/tags';
import { dollarsToCents } from '$lib/server/form-utils';
import { fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = () => {
	const rules = db
		.prepare(
			`SELECT r.id, r.merchant, r.min_amount_cents, r.max_amount_cents, r.provenance,
			        r.created_at, r.category_id, c.name AS category_name
			 FROM rules r LEFT JOIN categories c ON c.id = r.category_id
			 ORDER BY r.merchant COLLATE NOCASE`
		)
		.all() as {
		id: number;
		merchant: string;
		min_amount_cents: number | null;
		max_amount_cents: number | null;
		provenance: string | null;
		created_at: string;
		category_id: number | null;
		category_name: string | null;
	}[];
	const tagNames = db.prepare(
		`SELECT t.name FROM rule_tags rt JOIN tags t ON t.id = rt.tag_id
		 WHERE rt.rule_id = ? ORDER BY t.name COLLATE NOCASE`
	);
	return {
		rules: rules.map((r) => ({ ...r, tags: (tagNames.pluck().all(r.id) as string[]).join(', ') })),
		tree: groupedCategories(db),
		allTags: db.prepare('SELECT name FROM tags ORDER BY name COLLATE NOCASE').pluck().all() as string[]
	};
};

// amount bounds are magnitudes — abs() matches how the owner types them
const boundCents = (v: FormDataEntryValue | null): number | null => {
	const c = dollarsToCents(v);
	return c == null ? null : Math.abs(c);
};

export const actions: Actions = {
	update: async ({ request }) => {
		const f = await request.formData();
		const merchant = (f.get('merchant') as string)?.trim();
		if (!merchant) return fail(400, { message: 'Merchant required' });
		// comma-separated names; unknown ones are created (a Rule may be tag-only)
		const tagIds = ((f.get('tags') as string) ?? '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean)
			.map((name) => addTag(db, name));
		try {
			updateRule(db, Number(f.get('id')), {
				merchant,
				minAmountCents: boundCents(f.get('min')),
				maxAmountCents: boundCents(f.get('max')),
				categoryId: Number(f.get('category_id')) || null,
				tagIds
			});
		} catch (e) {
			return fail(400, { message: e instanceof Error ? e.message : String(e) });
		}
		return { ok: true };
	},
	delete: async ({ request }) => {
		const f = await request.formData();
		const id = formId(f);
		if (id == null || !deleteRule(db, id)) return fail(400, { message: 'no such Rule' });
		return { ok: true };
	}
};
