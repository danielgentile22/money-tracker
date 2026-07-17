import { db } from '$lib/server/db';
import { isAmbiguousMerchant } from '$lib/server/categorizer';
import { queryLedger, amountsFromUrl } from '$lib/server/ledger';
import { parseFilters } from '$lib/server/filters';
import { groupedCategories } from '$lib/server/groups';
import { listTags, tagsFor } from '$lib/server/tags';
import { listReports } from '$lib/server/saved-reports';
import { openReviewCount } from '$lib/server/dashboard';
import { savedReportActions } from '$lib/server/saved-report-actions';
import { ledgerActions } from '$lib/server/ledger-actions';
import { runLookupBatch, isBackfilling } from '$lib/server/backfill';
import { realReceiptSource } from '$lib/server/gmail';
import { realLlm } from '$lib/server/llm';
import type { PageServerLoad, Actions } from './$types';

const PAGE_SIZE = 100;

// The bulk receipt-search button covers every filtered spend charge, not just
// the visible page — same eligibility as the Settings scans (posted, non-
// transfer spending; investment activity is excluded by the filter engine).
function lookupTargets(url: URL): number[] {
	return queryLedger(db, parseFilters(url.searchParams), amountsFromUrl(url))
		.filter((r) => r.pending === 0 && r.is_transfer === 0 && r.amount_cents < 0)
		.map((r) => r.id);
}

export const load: PageServerLoad = ({ url }) => {
	// Session 3 retrofit: the ledger speaks the shared filter vocabulary —
	// multi-value include/exclude on every dimension. Amount stays page-local.
	const filters = parseFilters(url.searchParams);
	const amounts = amountsFromUrl(url);
	const focus = Number(url.searchParams.get('focus')) || null;
	let page = Math.max(1, Number(url.searchParams.get('page')) || 1);

	// ⌘K result selection: land on the page containing that Transaction
	if (focus) {
		const target = db
			.prepare('SELECT date FROM transactions WHERE id = ?')
			.get(focus) as { date: string } | undefined;
		if (target) {
			const before = db
				.prepare(
					`SELECT COUNT(*) FROM transactions t
					 WHERE t.is_investment_activity = 0 AND (t.date > ? OR (t.date = ? AND t.id > ?))`
				)
				.pluck()
				.get(target.date, target.date, focus) as number;
			page = Math.floor(before / PAGE_SIZE) + 1;
		}
	}

	const rows = queryLedger(db, filters, {
		...amounts,
		limit: PAGE_SIZE + 1,
		offset: (page - 1) * PAGE_SIZE
	});
	const pageRows = rows.slice(0, PAGE_SIZE);
	const tagMap = tagsFor(
		db,
		pageRows.map((r) => r.id)
	);

	const accounts = db.prepare('SELECT id, name FROM accounts ORDER BY name').all() as {
		id: number;
		name: string;
	}[];

	return {
		// Session 4: badge on the Review fold-in link — open items only, all kinds
		openReview: openReviewCount(db),
		lookupCount: lookupTargets(url).length,
		scanning: isBackfilling(),
		// ambiguous drives the apply-to-future toggle default (OFF for Amazon & co.)
		rows: pageRows.map((r) => ({
			...r,
			ambiguous: isAmbiguousMerchant(r.merchant ?? r.name),
			tags: tagMap.get(r.id) ?? []
		})),
		hasMore: rows.length > PAGE_SIZE,
		page,
		focus,
		accounts,
		tree: groupedCategories(db),
		// disabled Categories stay filterable — hiding from pickers never falsifies the past
		filterTree: groupedCategories(db, { includeDisabled: true }),
		allTags: listTags(db),
		merchants: db
			.prepare(
				`SELECT DISTINCT COALESCE(merchant, name) FROM transactions
				 WHERE is_investment_activity = 0 ORDER BY 1 COLLATE NOCASE`
			)
			.pluck()
			.all() as string[],
		saved: listReports(db, '/transactions'),
		hasDimensionFilters:
			// include and exclude (x-prefixed) keys both count as active filters
			['categories', 'groups', 'accounts', 'tags', 'merchants'].some(
				(k) => url.searchParams.has(k) || url.searchParams.has(`x${k}`)
			) ||
			url.searchParams.has('date') ||
			url.searchParams.has('from'),
		amounts: { min: url.searchParams.get('min'), max: url.searchParams.get('max') }
	};
};

export const actions: Actions = {
	...savedReportActions('/transactions', 'all', ['min', 'max']),
	...ledgerActions(),
	// the bulk cousin of ?/lookup: every filtered spend charge, fire-and-forget
	// like the Settings scans (shared one-at-a-time guard and progress channel)
	lookupAll: async ({ request }) => {
		const f = await request.formData();
		// the page's query string rides along so the batch matches what's filtered
		const url = new URL(String(f.get('qs') ?? ''), 'http://localhost');
		const ids = lookupTargets(url);
		void runLookupBatch(db, realReceiptSource, realLlm, ids).catch((e) =>
			console.error('bulk lookup failed:', e)
		);
		return { ok: true, started: ids.length };
	}
};
