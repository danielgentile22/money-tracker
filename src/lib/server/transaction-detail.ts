import type { Database } from 'better-sqlite3';
import type { ReceiptCandidate } from './gmail';
import type { ReceiptFacts } from './receipt-extractor';
import { explainRules } from './categorizer';

export type ReceiptSection = {
	state: 'not-searched' | 'pending' | 'matched' | 'exhausted';
	email: { from: string; subject: string; date: string; gmailUrl: string } | null;
	facts: ReceiptFacts | null;
};

export type MatchingRule = {
	id: number;
	merchant: string;
	min_amount_cents: number | null;
	max_amount_cents: number | null;
	category_id: number | null;
	category_name: string | null;
};

export type TransactionDetail = {
	id: number;
	date: string;
	merchant: string | null;
	rawName: string; // "as it appeared" — the bank-statement string
	amount_cents: number;
	pending: boolean;
	account_name: string;
	category: { id: number | null; name: string | null; source: string | null };
	plaid: { primary: string | null; detailed: string | null; confidence: string | null };
	// a Transfer swaps the receipt+rules sections for its paired leg
	receipt: ReceiptSection | null;
	rules: { matches: MatchingRule[]; winnerId: number | null; drifted: boolean } | null;
	transferPeer: { id: number; date: string; account_name: string; amount_cents: number } | null;
	recurring: { id: number; cadence: string; typical_amount_cents: number } | null;
	tags: { id: number; name: string }[];
};

/**
 * The detail dialog's whole payload for one Transaction. The stored Receipt
 * candidate's body never leaves the server — the dialog shows metadata plus
 * an open-in-Gmail link instead.
 */
export function getTransactionDetail(db: Database, id: number): TransactionDetail {
	const t = db
		.prepare(
			`SELECT t.*, a.name AS account_name
			 FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.id = ?`
		)
		.get(id) as Record<string, unknown> | undefined;
	if (!t) throw new Error(`no Transaction ${id}`);

	const isTransfer = !!t.is_transfer;
	const candidate =
		!isTransfer && t.receipt_json ? (JSON.parse(t.receipt_json as string) as ReceiptCandidate) : null;
	const receipt: ReceiptSection | null = isTransfer ? null : {
		state: (t.receipt_search_state as ReceiptSection['state'] | null) ?? 'not-searched',
		email: candidate
			? {
					from: candidate.from,
					subject: candidate.subject,
					date: candidate.date,
					gmailUrl: `https://mail.google.com/mail/?authuser=${encodeURIComponent(candidate.inboxAddress)}#all/${candidate.messageId}`
				}
			: null,
		facts: t.receipt_facts_json ? (JSON.parse(t.receipt_facts_json as string) as ReceiptFacts) : null
	};

	// "rules that apply" always answers *now* (CONTEXT.md, Rule) — matched live,
	// since which Rule fired historically is never recorded
	let rules: TransactionDetail['rules'] = null;
	if (!isTransfer) {
		const allRules = db
			.prepare(
				`SELECT r.id, r.merchant, r.min_amount_cents, r.max_amount_cents, r.category_id,
				        c.name AS category_name
				 FROM rules r LEFT JOIN categories c ON c.id = r.category_id`
			)
			.all() as MatchingRule[];
		rules = explainRules(
			{ merchant: (t.merchant as string | null) ?? (t.name as string), amount_cents: t.amount_cents as number },
			allRules,
			{ categoryId: t.category_id as number | null, source: t.category_source as string | null }
		) as { matches: MatchingRule[]; winnerId: number | null; drifted: boolean };
	}

	const transferPeer = t.transfer_peer_id
		? (db
				.prepare(
					`SELECT t.id, t.date, t.amount_cents, a.name AS account_name
					 FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.id = ?`
				)
				.get(t.transfer_peer_id) as TransactionDetail['transferPeer'])
		: null;

	const categoryName = t.category_id
		? (db.prepare('SELECT name FROM categories WHERE id = ?').pluck().get(t.category_id) as string)
		: null;

	return {
		id: t.id as number,
		date: t.date as string,
		merchant: t.merchant as string | null,
		rawName: t.name as string,
		amount_cents: t.amount_cents as number,
		pending: !!t.pending,
		account_name: t.account_name as string,
		category: {
			id: t.category_id as number | null,
			name: categoryName,
			source: t.category_source as string | null
		},
		plaid: {
			primary: t.plaid_category_primary as string | null,
			detailed: t.plaid_category_detailed as string | null,
			confidence: t.plaid_confidence as string | null
		},
		receipt,
		rules,
		transferPeer,
		recurring: t.recurring_series_id
			? (db
					.prepare('SELECT id, cadence, typical_amount_cents FROM recurring_series WHERE id = ?')
					.get(t.recurring_series_id) as TransactionDetail['recurring'])
			: null,
		tags: db
			.prepare(
				`SELECT tg.id, tg.name FROM transaction_tags tt
				 JOIN tags tg ON tg.id = tt.tag_id WHERE tt.transaction_id = ? ORDER BY tg.name`
			)
			.all(id) as { id: number; name: string }[]
	};
}
