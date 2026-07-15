// Pure categorization ladder (ADR-0005): Rules beat Plaid mapping; Corrections
// beat both (enforced at the db layer — correction-source rows are never
// overwritten). No db, no framework, no mocks needed.

export type RuleRow = {
	id: number;
	merchant: string;
	min_amount_cents: number | null; // absolute cents — the owner thinks in magnitudes
	max_amount_cents: number | null;
	category_id: number | null; // null = a tag-only Rule; it never decides the Category
};

export type TxnFacts = {
	merchant: string;
	amount_cents: number;
	pfc_primary: string | null;
	pfc_detailed: string | null;
};

// CONTEXT.md's ambiguous-payee list: one charge says nothing about the next.
const AMBIGUOUS = ['amazon', 'amzn', 'paypal', 'venmo', 'zelle', 'cash app'];

export function isAmbiguousMerchant(merchant: string): boolean {
	const m = merchant.toLowerCase();
	return AMBIGUOUS.some((a) => m.includes(a));
}

/**
 * Plaid's merchant_name when present, else strip processor noise from the raw
 * bank string. The result is the Rule matching key (matched case-insensitively).
 */
// ponytail: strips SQ*/TST*-style prefixes, #123 store numbers, and long numeric
// tails only — city/state suffixes survive. Extend the patterns at p1-11 when
// a real bank strings show what else needs stripping.
export function normalizeMerchant(rawName: string, plaidMerchantName?: string | null): string {
	const clean = plaidMerchantName?.trim();
	if (clean) return clean;
	let s = rawName;
	s = s.replace(/^(SQ|TST|SP|PY|PAYPAL)\s*\*\s*/i, '');
	s = s.replace(/\s*#\d+\b/g, '');
	s = s.replace(/\s+\d{3,}$/, '');
	s = s.replace(/\s{2,}/g, ' ').trim();
	return s || rawName.trim();
}

/** Merchant + |amount|-range predicate shared by the ladder, explainer, and Tag application. */
export function fits(r: RuleRow, merchant: string, abs: number): boolean {
	return (
		r.merchant.toLowerCase() === merchant &&
		(r.min_amount_cents == null || abs >= r.min_amount_cents) &&
		(r.max_amount_cents == null || abs <= r.max_amount_cents)
	);
}

// Range width as a specificity score: narrower wins. An open side extends to the
// absolute-cents limits (0 / MAX_SAFE_INTEGER), so a half-open Rule still beats a
// fully unranged one, and both beat nothing — no NaN, no Infinity arithmetic.
function span(r: RuleRow): number {
	return (r.max_amount_cents ?? Number.MAX_SAFE_INTEGER) - (r.min_amount_cents ?? 0);
}

/**
 * The winning Rule for a Transaction: among all that fit, the narrowest |amount|
 * range wins (a ranged Rule beats an unranged one for the same Merchant), ties
 * broken by lowest id. Deterministic regardless of row/scan order — the same
 * Transaction and Rules always yield the same Category.
 */
export function matchRule(
	txn: Pick<TxnFacts, 'merchant' | 'amount_cents'>,
	rules: readonly RuleRow[]
): RuleRow | null {
	const merchant = txn.merchant.toLowerCase();
	const abs = Math.abs(txn.amount_cents);
	// tag-only Rules attach Tags elsewhere; the ladder skips them
	const hits = rules.filter((r) => r.category_id != null && fits(r, merchant, abs));
	if (hits.length === 0) return null;
	return hits.reduce((best, r) => {
		const bs = span(best);
		const rs = span(r);
		return rs < bs || (rs === bs && r.id < best.id) ? r : best;
	});
}

/**
 * The detail view's "rules that apply". Which Rule fired historically is never
 * recorded (CONTEXT.md, Rule) — this always answers *now*: every Rule matching
 * the Transaction, the winner under matchRule precedence, and a drift flag for
 * "categorized by a rule that has since changed".
 */
export function explainRules(
	txn: Pick<TxnFacts, 'merchant' | 'amount_cents'>,
	rules: readonly RuleRow[],
	current: { categoryId: number | null; source: string | null }
): { matches: RuleRow[]; winnerId: number | null; drifted: boolean } {
	const merchant = txn.merchant.toLowerCase();
	const abs = Math.abs(txn.amount_cents);
	const matches = rules.filter((r) => fits(r, merchant, abs));
	const winner = matchRule(txn, rules);
	const drifted = current.source === 'rule' && winner?.category_id !== current.categoryId;
	return { matches, winnerId: winner?.id ?? null, drifted };
}

export type Categorized = { categoryId: number; source: 'rule' | 'plaid' } | null;

export function categorize(
	txn: TxnFacts,
	rules: readonly RuleRow[],
	map: ReadonlyMap<string, number>
): Categorized {
	const rule = matchRule(txn, rules);
	if (rule) return { categoryId: rule.category_id!, source: 'rule' };
	const mapped =
		(txn.pfc_detailed ? map.get(txn.pfc_detailed) : undefined) ??
		(txn.pfc_primary ? map.get(txn.pfc_primary) : undefined);
	return mapped != null ? { categoryId: mapped, source: 'plaid' } : null;
}

/**
 * Unresolved charge (CONTEXT.md): no Rule match AND (Plaid confidence below
 * HIGH OR ambiguous payee). The candidate set for Phase 3 email lookup.
 */
export function isUnresolved(
	txn: Pick<TxnFacts, 'merchant'>,
	confidence: string | null,
	hasRuleMatch: boolean
): boolean {
	if (hasRuleMatch) return false;
	const confident = confidence === 'HIGH' || confidence === 'VERY_HIGH';
	return !confident || isAmbiguousMerchant(txn.merchant);
}
