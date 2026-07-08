import { db } from '$lib/server/db';
import { clearBudget, setBudget, setRolloverAnchor } from '$lib/server/budgets';
import { categoriesMonth, monthCursor } from '$lib/server/categories-page';
import { categoryDetail } from '$lib/server/category-detail';
import { queryLedger } from '$lib/server/ledger';
import { isAmbiguousMerchant } from '$lib/server/categorizer';
import {
	addCategory,
	deleteCategory,
	renameCategory,
	setCategoryEmoji
} from '$lib/server/categories';
import {
	groupedCategories,
	addGroup,
	renameGroup,
	setGroupEmoji,
	deleteGroup,
	moveCategoryToGroup,
	nudgeGroup,
	nudgeCategory
} from '$lib/server/groups';
import { listTags, tagsFor } from '$lib/server/tags';
import { ledgerActions } from '$lib/server/ledger-actions';
import { shiftMonth } from '$lib/server/analytics';
import { localToday } from '$lib/server/balances';
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The open Category's panel: engine facts + its month-scoped Ledger. */
function openCategory(month: string, categoryId: number) {
	const facts = categoryDetail(db, categoryId, month, localToday());
	if (!facts) return null;
	// the audit Ledger = the one ledger query, scoped (category, cursor month).
	// ponytail: no pagination — one category-month is at most dozens of rows.
	const rows = queryLedger(db, {
		categories: { include: [categoryId] },
		date: { from: `${month}-01`, to: `${month}-31` } // '-31' safe: stored dates are real days
	});
	const tagMap = tagsFor(
		db,
		rows.map((r) => r.id)
	);
	return {
		...facts,
		rows: rows.map((r) => ({
			...r,
			ambiguous: isAmbiguousMerchant(r.merchant ?? r.name),
			tags: tagMap.get(r.id) ?? []
		})),
		allTags: listTags(db)
		// the Ledger's Category picker reuses the page-level `tree`
	};
}

export const load: PageServerLoad = ({ url }) => {
	const month = monthCursor(url.searchParams.get('month'), localToday());
	const categoryId = Number(url.searchParams.get('category')) || null;
	return {
		...categoriesMonth(db, month),
		tree: groupedCategories(db), // the manage dialogs' Group/destination pickers
		detail: categoryId ? openCategory(month, categoryId) : null,
		focus: Number(url.searchParams.get('focus')) || null,
		prev: shiftMonth(month, -1),
		next: shiftMonth(month, 1),
		current: localToday().slice(0, 7)
	};
};

/** Blank input = clear (zero row); otherwise a non-negative dollar amount. */
function parseCents(raw: FormDataEntryValue | null): number | null {
	if (raw === null || String(raw).trim() === '') return 0;
	const dollars = Number(raw);
	if (!Number.isFinite(dollars) || dollars < 0) return null;
	return Math.round(dollars * 100);
}

/** Budget-form redirects keep the whole page state: cursor month AND open category. */
function backTo(url: URL, month: string): string {
	const cat = url.searchParams.get('category');
	return `${url.pathname}?month=${month}${cat ? `&category=${cat}` : ''}`;
}

/**
 * Management POSTs (slice 5): domain errors surface in the page banner;
 * success redirects back to the cursor month the form's action URL carried.
 */
function manage(url: URL, fn: () => void) {
	try {
		fn();
	} catch (e) {
		let message = e instanceof Error ? e.message : String(e);
		// domain modules speak domain language; translate the one raw SQLite
		// error a rename/add can trip (names are UNIQUE on both tables)
		if (message.includes('UNIQUE constraint failed')) message = 'That name is already taken';
		return fail(400, { message });
	}
	redirect(303, backTo(url, monthCursor(url.searchParams.get('month'), localToday())));
}

// satisfies (not `: Actions`) so ActionData keeps per-action fields (AGENTS.md)
export const actions = {
	...ledgerActions(),
	addCat: async ({ request, url }) => {
		const f = await request.formData();
		return manage(url, () => {
			// addCategory upserts (built for inline mid-Correction creation) — the
			// manager wants a strict create, not a silent emoji-clobber of the
			// existing Category a name collision would return
			const name = String(f.get('name') ?? '').trim();
			const existing = db
				.prepare('SELECT 1 FROM categories WHERE name = ?')
				.pluck()
				.get(name);
			if (existing) throw new Error(`"${name}" already exists`);
			const id = addCategory(db, name, Number(f.get('group_id')));
			setCategoryEmoji(db, id, f.get('emoji') as string);
		});
	},
	renameCat: async ({ request, url }) => {
		const f = await request.formData();
		return manage(url, () => {
			renameCategory(db, Number(f.get('id')), f.get('name') as string);
			setCategoryEmoji(db, Number(f.get('id')), f.get('emoji') as string);
		});
	},
	// delete is re-home (ADR-0008): in-use Categories move their history to the
	// picked destination first; unused ones send no destination
	deleteCat: async ({ request, url }) => {
		const f = await request.formData();
		return manage(url, () =>
			deleteCategory(db, Number(f.get('id')), Number(f.get('destination')) || undefined)
		);
	},
	moveCat: async ({ request, url }) => {
		const f = await request.formData();
		return manage(url, () =>
			moveCategoryToGroup(db, Number(f.get('id')), Number(f.get('group_id')))
		);
	},
	nudgeCat: async ({ request, url }) => {
		const f = await request.formData();
		return manage(url, () =>
			nudgeCategory(db, Number(f.get('id')), f.get('dir') === 'up' ? -1 : 1)
		);
	},
	addGroup: async ({ request, url }) => {
		const f = await request.formData();
		return manage(url, () => void addGroup(db, f.get('name') as string));
	},
	renameGroup: async ({ request, url }) => {
		const f = await request.formData();
		return manage(url, () => {
			renameGroup(db, Number(f.get('id')), f.get('name') as string);
			setGroupEmoji(db, Number(f.get('id')), f.get('emoji') as string);
		});
	},
	deleteGroup: async ({ request, url }) => {
		const f = await request.formData();
		return manage(url, () => deleteGroup(db, Number(f.get('id'))));
	},
	nudgeGroup: async ({ request, url }) => {
		const f = await request.formData();
		return manage(url, () =>
			nudgeGroup(db, Number(f.get('id')), f.get('dir') === 'up' ? -1 : 1)
		);
	},
	set: async ({ request, url }) => {
		const f = await request.formData();
		const month = String(f.get('month'));
		if (!MONTH_RE.test(month)) return fail(400, { message: 'bad month' });
		const cents = parseCents(f.get('dollars'));
		if (cents === null) return fail(400, { message: 'Budget must be a non-negative dollar amount' });
		const id = Number(f.get('category_id'));
		if (cents === 0) clearBudget(db, id, month);
		else setBudget(db, id, month, cents);
		redirect(303, backTo(url, month));
	},
	rollover: async ({ request, url }) => {
		const f = await request.formData();
		const month = String(f.get('month'));
		if (!MONTH_RE.test(month)) return fail(400, { message: 'bad month' });
		// on = anchor at the viewed month ($0 start); off = null. Re-enable re-anchors.
		setRolloverAnchor(db, Number(f.get('category_id')), f.get('enable') === '1' ? month : null);
		redirect(303, backTo(url, month));
	}
} satisfies Actions;
