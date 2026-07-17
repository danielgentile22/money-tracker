import type { Database } from 'better-sqlite3';

// Shared between the monthly (digest.ts) and weekly (weekly-digest.ts) digest
// builders — one copy of the dollars rounding, the top-merchants query, and
// the data-quality counts the narration hedges on (#54).

export const dollars = (cents: number) => Math.round(cents) / 100;

export type MerchantSpend = { name: string; spent_cents: number; txn_count: number };

/** Top spend merchants in [fromDate, toDate) — ADR-0003 exclusions apply. */
export function topMerchants(
	db: Database,
	fromDate: string,
	toDate: string,
	limit: number
): MerchantSpend[] {
	return db
		.prepare(
			`SELECT COALESCE(merchant, name) AS name, SUM(-amount_cents) AS spent_cents, COUNT(*) AS txn_count
			 FROM transactions
			 WHERE is_investment_activity = 0 AND is_transfer = 0 AND amount_cents < 0
			   AND date >= ? AND date < ?
			 GROUP BY COALESCE(merchant, name) ORDER BY spent_cents DESC LIMIT ?`
		)
		.all(fromDate, toDate, limit) as MerchantSpend[];
}

/** Aggregate counts only — so narration hedges what the hygiene backlog still moves. */
export function dataQualityCounts(db: Database): {
	open_review_items: number;
	unresolved_charges: number;
	rejected_not_reopened: number;
} {
	const count = (sql: string) => db.prepare(sql).pluck().get() as number;
	return {
		open_review_items: count("SELECT COUNT(*) FROM review_items WHERE status = 'open'"),
		unresolved_charges: count(
			'SELECT COUNT(*) FROM transactions WHERE unresolved = 1 AND is_investment_activity = 0'
		),
		rejected_not_reopened: count("SELECT COUNT(*) FROM review_items WHERE status = 'rejected'")
	};
}
