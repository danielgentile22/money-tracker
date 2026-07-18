import type { Database } from 'better-sqlite3';
import { compileFilters, type FilterSet } from './filters';
import { localToday } from './balances';

// Session 3 retrofit: the ledger is the filter engine's second consumer.
// FilterSet covers the analysis dimensions; amount min/max stays page-local.
export type LedgerOpts = {
	minAmountCents?: number; // absolute — the owner thinks in magnitudes
	maxAmountCents?: number;
	sign?: 'spending' | 'income'; // drill-down lists show what the aggregates counted
	today?: string;
	limit?: number;
	offset?: number;
};

export type LedgerRow = {
	id: number;
	date: string;
	merchant: string | null;
	name: string;
	amount_cents: number;
	pending: number;
	unresolved: number;
	is_transfer: number;
	is_excluded: number;
	is_saved: number;
	category_source: string | null;
	receipt_search_state: string | null;
	receipt_facts_json: string | null;
	account_name: string;
	category_name: string | null;
	recurring_cadence: string | null;
	recurring_typical_cents: number | null;
};

const BASE = `SELECT t.id, t.date, t.merchant, t.name, t.amount_cents, t.pending, t.unresolved,
       t.is_transfer, t.is_excluded, t.is_saved, t.category_source, t.receipt_search_state, t.receipt_facts_json,
       a.name AS account_name, c.name AS category_name,
       rs.cadence AS recurring_cadence, rs.typical_amount_cents AS recurring_typical_cents
FROM transactions t
JOIN accounts a ON a.id = t.account_id
LEFT JOIN categories c ON c.id = t.category_id
LEFT JOIN recurring_series rs ON rs.id = t.recurring_series_id`;

/** Page-local amount bounds off a page/export URL (shared by both routes). */
export function amountsFromUrl(url: URL): Pick<LedgerOpts, 'minAmountCents' | 'maxAmountCents'> {
	const dollars = (k: string) => {
		const v = url.searchParams.get(k)?.trim();
		if (!v) return undefined;
		const n = Number(v);
		return Number.isFinite(n) ? Math.round(Math.abs(n) * 100) : undefined;
	};
	return { minAmountCents: dollars('min'), maxAmountCents: dollars('max') };
}

export function queryLedger(db: Database, f: FilterSet, opts: LedgerOpts = {}): LedgerRow[] {
	const { clauses, params } = compileFilters(f, opts.today ?? localToday());
	if (opts.minAmountCents != null) {
		clauses.push('ABS(t.amount_cents) >= ?');
		params.push(opts.minAmountCents);
	}
	if (opts.maxAmountCents != null) {
		clauses.push('ABS(t.amount_cents) <= ?');
		params.push(opts.maxAmountCents);
	}
	// aggregate views never count Transfers (ADR-0003); their drill-downs match
	if (opts.sign === 'spending') clauses.push('t.is_transfer = 0 AND t.is_excluded = 0', 't.amount_cents < 0');
	if (opts.sign === 'income') clauses.push('t.is_transfer = 0 AND t.is_excluded = 0', 't.amount_cents > 0');
	// bound + coerced: user-controlled ?page must never reach SQL text, and
	// NaN/Infinity/oversized values must not reach the binder (#73)
	const toInt = (v: number, fallback: number) =>
		Number.isSafeInteger(Math.trunc(v)) ? Math.trunc(v) : fallback;
	const limit = toInt(opts.limit ?? -1, -1) || -1; // SQLite: LIMIT -1 = no limit
	const offset = Math.max(0, toInt(opts.offset ?? 0, 0));
	params.push(limit, offset);
	return db
		.prepare(`${BASE} WHERE ${clauses.join(' AND ')} ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`)
		.all(...params) as LedgerRow[];
}

/** ⌘K: normalized Merchant substring, exact |amount| ("63.47"), or Category name. */
export function searchTransactions(db: Database, query: string, limit = 20): LedgerRow[] {
	const q = query.trim();
	if (!q) return [];
	const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`; // % and _ are literals in search (#58)
	const asNumber = Number(q.replace(/^\$/, ''));
	const exactCents = Number.isFinite(asNumber) && q !== '' ? Math.round(Math.abs(asNumber) * 100) : null;
	return db
		.prepare(
			`${BASE}
			 WHERE t.is_investment_activity = 0 AND (
			   COALESCE(t.merchant, t.name) LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' ${exactCents != null ? 'OR ABS(t.amount_cents) = ?' : ''}
			 )
			 ORDER BY t.date DESC, t.id DESC LIMIT ?`
		)
		.all(
			...(exactCents != null ? [like, like, exactCents, limit] : [like, like, limit])
		) as LedgerRow[];
}

/** RFC-4180-style escaping: quote fields containing commas, quotes, or newlines.
 * Bank-fed text starting with a formula sigil gets a leading apostrophe so a
 * spreadsheet renders it inert instead of executing it (#72). */
export function toCsv(rows: LedgerRow[]): string {
	const esc = (v: string | number | null): string => {
		let s = v == null ? '' : String(v);
		if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
		return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
	};
	const header =
		'date,merchant,account,category,amount,pending,transfer,excluded,saved,unresolved';
	const lines = rows.map((r) =>
		[
			r.date,
			esc(r.merchant ?? r.name),
			esc(r.account_name),
			esc(r.category_name),
			(r.amount_cents / 100).toFixed(2),
			r.pending ? 'yes' : '',
			r.is_transfer ? 'yes' : '',
			r.is_excluded ? 'yes' : '',
			r.is_saved ? 'yes' : '',
			r.unresolved ? 'yes' : ''
		].join(',')
	);
	return [header, ...lines].join('\n') + '\n';
}
