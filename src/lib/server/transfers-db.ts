import type { Database } from 'better-sqlite3';
import { detectTransfers, isAssetAccount, type TransferTxn } from './transfers';

type AmbiguityPayload = { txnId: number; candidateIds: number[] };

/**
 * Runs after every sync, across all Connections (a checking→investment
 * contribution spans two). Confident pairs get flagged. A Transaction with an
 * open or rejected review item is excluded from detection entirely: pending
 * judgment stays pending, and a rejection is final — no auto-pair, no
 * re-enqueue, even if a plausible partner shows up on a later sync.
 */
export function runTransferDetection(db: Database): void {
	const windowDays = Number(
		(db.prepare("SELECT value FROM settings WHERE key = 'transfer_window_days'").pluck().get() as
			| string
			| undefined) ?? '4'
	);

	// Reserve every leg that already has a live judgment path so a later sync
	// can't auto-pair it behind the owner's back. An open item reserves its
	// subject AND its candidates (all pending); a rejected item only finalizes
	// its own subject — its candidate legs (innocent partners) stay eligible.
	const judged = new Set<number>();
	for (const r of db
		.prepare(
			"SELECT payload, status FROM review_items WHERE kind = 'transfer-ambiguity' AND status IN ('open', 'rejected')"
		)
		.all() as { payload: string; status: string }[]) {
		const p = JSON.parse(r.payload) as AmbiguityPayload;
		judged.add(p.txnId);
		if (r.status === 'open') for (const c of p.candidateIds) judged.add(c);
	}

	const rows = db
		.prepare(
			`SELECT t.id, t.account_id, t.date, t.amount_cents,
			        t.plaid_category_primary, t.plaid_category_detailed
			 FROM transactions t
			 WHERE t.is_transfer = 0 AND t.pending = 0 AND t.transfer_peer_id IS NULL
			   AND t.is_investment_activity = 0`
		)
		.all() as {
		id: number;
		account_id: number;
		date: string;
		amount_cents: number;
		plaid_category_primary: string | null;
		plaid_category_detailed: string | null;
	}[];

	const txns: TransferTxn[] = rows
		.filter((r) => !judged.has(r.id))
		.map((r) => ({
			id: r.id,
			account_id: r.account_id,
			date: r.date,
			amount_cents: r.amount_cents,
			transfer_signal:
				r.plaid_category_primary === 'TRANSFER_IN' ||
				r.plaid_category_primary === 'TRANSFER_OUT' ||
				r.plaid_category_detailed === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'
		}));

	const { pairs, ambiguous } = detectTransfers(txns, { windowDays });

	const enqueue = db.prepare(
		"INSERT INTO review_items (kind, payload) VALUES ('transfer-ambiguity', ?)"
	);
	db.transaction(() => {
		for (const pair of pairs) markPair(db, pair.outId, pair.inId);
		for (const a of ambiguous) enqueue.run(JSON.stringify(a));
	})();
}

/** Flag both legs; the in-leg into an asset Account additionally counts as saved. */
export function markPair(db: Database, outId: number, inId: number): void {
	// `AND transfer_peer_id IS NULL` + changes===1 guard: a leg already paired
	// (a race, or a stale approval) fails loudly instead of half-applying a
	// one-way pointer, keeping the "transfer_peer_id is always mutual" invariant.
	// The own transaction (a savepoint when nested) rolls the first UPDATE back
	// if the second leg won't take, so mutuality holds even for direct callers.
	const link = db.prepare(
		'UPDATE transactions SET is_transfer = 1, transfer_peer_id = ? WHERE id = ? AND transfer_peer_id IS NULL'
	);
	db.transaction(() => {
		if (link.run(inId, outId).changes !== 1 || link.run(outId, inId).changes !== 1)
			throw new Error(`markPair: a leg is already paired (${outId} ↔ ${inId})`);
	})();
	const inLeg = db
		.prepare(
			`SELECT a.type, a.subtype FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.id = ?`
		)
		.get(inId) as { type: string; subtype: string | null };
	if (isAssetAccount(inLeg.type, inLeg.subtype)) {
		db.prepare('UPDATE transactions SET is_saved = 1 WHERE id = ?').run(inId);
	}
}

export function approveReviewItem(db: Database, itemId: number, candidateId: number): void {
	const item = getItem(db, itemId);
	const p = JSON.parse(item.payload) as AmbiguityPayload;
	if (!p.candidateIds.includes(candidateId))
		throw new Error(`candidate ${candidateId} is not a partner offered by review item ${itemId}`);
	const legState = (id: number) =>
		db
			.prepare('SELECT amount_cents, transfer_peer_id, is_transfer FROM transactions WHERE id = ?')
			.get(id) as { amount_cents: number; transfer_peer_id: number | null; is_transfer: number } | undefined;
	const txn = legState(p.txnId);
	const cand = legState(candidateId);
	if (!txn || !cand) throw new Error(`review item ${itemId} references a deleted transaction`);
	if (txn.transfer_peer_id !== null || txn.is_transfer !== 0 || cand.transfer_peer_id !== null || cand.is_transfer !== 0)
		throw new Error(`review item ${itemId} is stale — a leg has already been paired`);
	db.transaction(() => {
		if (txn.amount_cents < 0) markPair(db, p.txnId, candidateId);
		else markPair(db, candidateId, p.txnId);
		db.prepare(
			"UPDATE review_items SET status = 'approved', resolved_at = datetime('now') WHERE id = ?"
		).run(itemId);
		supersedeOverlapping(db, itemId, [p.txnId, candidateId]);
	})();
}

/**
 * Close any other open transfer-ambiguity item that touches a transaction we
 * just resolved, so a leftover sibling can't later re-judge (and partially
 * undo) the same leg. ponytail: recorded as 'approved' — the review_items CHECK
 * allows only open/approved/rejected; a distinct 'superseded' status would need
 * a table-rebuild migration, add one if approval history ever needs the split.
 */
function supersedeOverlapping(db: Database, keepItemId: number, resolvedIds: number[]): void {
	const set = new Set(resolvedIds);
	const open = db
		.prepare(
			"SELECT id, payload FROM review_items WHERE kind = 'transfer-ambiguity' AND status = 'open' AND id != ?"
		)
		.all(keepItemId) as { id: number; payload: string }[];
	const close = db.prepare(
		"UPDATE review_items SET status = 'approved', resolved_at = datetime('now') WHERE id = ?"
	);
	for (const s of open) {
		const p = JSON.parse(s.payload) as AmbiguityPayload;
		if (set.has(p.txnId) || p.candidateIds.some((c) => set.has(c))) close.run(s.id);
	}
}

/**
 * One-sided Transfer (p1-12): the partner leg lives at an institution that
 * gives us no transactions (e.g. ride-along 529s), so the visible leg alone
 * is marked. `saved` puts the contribution into Phase 2's savings-rate math —
 * normally the asset-side in-leg carries that flag, but here this leg is the
 * only record of the contribution.
 */
export function approveLoneLeg(db: Database, itemId: number, saved: boolean): void {
	const item = getItem(db, itemId);
	const p = JSON.parse(item.payload) as AmbiguityPayload;
	const txn = db
		.prepare('SELECT transfer_peer_id FROM transactions WHERE id = ?')
		.get(p.txnId) as { transfer_peer_id: number | null } | undefined;
	if (!txn) throw new Error(`review item ${itemId} references a deleted transaction`);
	// Refuse to touch a leg that a sibling item already paired — flipping is_saved
	// here would silently drop a contribution from the ADR-0003 savings math.
	if (txn.transfer_peer_id !== null)
		throw new Error(`review item ${itemId} is stale — this leg is already paired`);
	db.transaction(() => {
		db.prepare('UPDATE transactions SET is_transfer = 1, is_saved = ? WHERE id = ?').run(
			saved ? 1 : 0,
			p.txnId
		);
		db.prepare(
			"UPDATE review_items SET status = 'approved', resolved_at = datetime('now') WHERE id = ?"
		).run(itemId);
		supersedeOverlapping(db, itemId, [p.txnId]);
	})();
}

export function rejectReviewItem(db: Database, itemId: number): void {
	getItem(db, itemId); // throws on unknown id
	db.prepare(
		"UPDATE review_items SET status = 'rejected', resolved_at = datetime('now') WHERE id = ?"
	).run(itemId);
}

/**
 * Rejection's undo: back to the queue for a fresh verdict. Safe because
 * rejecting never touched the Transaction — open and rejected items gate
 * auto-detection identically, so reopening only changes what the owner sees.
 */
export function reopenReviewItem(db: Database, itemId: number): void {
	const changed = db
		.prepare("UPDATE review_items SET status = 'open', resolved_at = NULL WHERE id = ? AND status = 'rejected'")
		.run(itemId).changes;
	if (changed === 0) throw new Error(`no rejected review item ${itemId}`);
}

function getItem(db: Database, itemId: number) {
	const item = db
		.prepare("SELECT id, payload FROM review_items WHERE id = ? AND status = 'open'")
		.get(itemId) as { id: number; payload: string } | undefined;
	if (!item) throw new Error(`no open review item ${itemId}`);
	return item;
}
