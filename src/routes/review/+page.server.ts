import { fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import {
	approveReviewItem,
	approveLoneLeg,
	rejectReviewItem,
	reopenReviewItem
} from '$lib/server/transfers-db';
import type { PageServerLoad, Actions } from './$types';

type TxnEvidence = {
	id: number;
	date: string;
	merchant: string | null;
	name: string;
	amount_cents: number;
	account_name: string;
};

export const load: PageServerLoad = () => {
	const items = db
		.prepare(
			"SELECT id, kind, payload FROM review_items WHERE status = 'open' ORDER BY created_at"
		)
		.all() as { id: number; kind: string; payload: string }[];

	const txnById = db.prepare(
		`SELECT t.id, t.date, t.merchant, t.name, t.amount_cents, a.name AS account_name
		 FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.id = ?`
	);

	// rejection is undoable: rejected items stay reachable for a fresh verdict
	const rejected = (
		db
			.prepare(
				"SELECT id, payload, resolved_at FROM review_items WHERE status = 'rejected' ORDER BY resolved_at DESC, id DESC"
			)
			.all() as { id: number; payload: string; resolved_at: string | null }[]
	).map((item) => ({
		id: item.id,
		resolved_at: item.resolved_at,
		txn: txnById.get((JSON.parse(item.payload) as { txnId: number }).txnId) as
			| TxnEvidence
			| undefined
	}));

	return {
		items: items.map((item) => {
			const p = JSON.parse(item.payload) as { txnId: number; candidateIds: number[] };
			return {
				id: item.id,
				kind: item.kind,
				// lone-leg (offer the one-sided buttons) is a property of the payload,
				// not of how many candidate rows survive — a pair item whose candidates
				// were all sync-deleted is not a lone leg and must not get those buttons.
				isLoneLeg: p.candidateIds.length === 0,
				txn: txnById.get(p.txnId) as TxnEvidence | undefined,
				candidates: p.candidateIds
					.map((c) => txnById.get(c) as TxnEvidence | undefined)
					.filter(Boolean) as TxnEvidence[]
			};
		}),
		rejected
	};
};

// Plain-form POSTs with keyboard advance make double-submit the normal case (a
// double Enter, a stale second tab): a stale/deleted id must fail gracefully,
// not 500 the review flow. Mirrors settings' act() helper.
function act(fn: () => void) {
	try {
		fn();
		return { ok: true };
	} catch (e) {
		return fail(400, { message: e instanceof Error ? e.message : String(e) });
	}
}

export const actions: Actions = {
	approve: async ({ request }) => {
		const f = await request.formData();
		return act(() => approveReviewItem(db, Number(f.get('id')), Number(f.get('candidate_id'))));
	},
	approveLone: async ({ request }) => {
		const f = await request.formData();
		return act(() => approveLoneLeg(db, Number(f.get('id')), f.get('saved') === '1'));
	},
	reject: async ({ request }) => {
		const f = await request.formData();
		return act(() => rejectReviewItem(db, Number(f.get('id'))));
	},
	reopen: async ({ request }) => {
		const f = await request.formData();
		return act(() => reopenReviewItem(db, Number(f.get('id'))));
	}
};
