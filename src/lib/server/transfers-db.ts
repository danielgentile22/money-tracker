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

	const judged = new Set<number>(
		(
			db
				.prepare(
					"SELECT payload FROM review_items WHERE kind = 'transfer-ambiguity' AND status IN ('open', 'rejected')"
				)
				.all() as { payload: string }[]
		).map((r) => (JSON.parse(r.payload) as AmbiguityPayload).txnId)
	);

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
	db.prepare('UPDATE transactions SET is_transfer = 1, transfer_peer_id = ? WHERE id = ?').run(
		inId,
		outId
	);
	db.prepare('UPDATE transactions SET is_transfer = 1, transfer_peer_id = ? WHERE id = ?').run(
		outId,
		inId
	);
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
	const txn = db
		.prepare('SELECT amount_cents FROM transactions WHERE id = ?')
		.get(p.txnId) as { amount_cents: number };
	db.transaction(() => {
		if (txn.amount_cents < 0) markPair(db, p.txnId, candidateId);
		else markPair(db, candidateId, p.txnId);
		db.prepare(
			"UPDATE review_items SET status = 'approved', resolved_at = datetime('now') WHERE id = ?"
		).run(itemId);
	})();
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
	db.transaction(() => {
		db.prepare('UPDATE transactions SET is_transfer = 1, is_saved = ? WHERE id = ?').run(
			saved ? 1 : 0,
			p.txnId
		);
		db.prepare(
			"UPDATE review_items SET status = 'approved', resolved_at = datetime('now') WHERE id = ?"
		).run(itemId);
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
