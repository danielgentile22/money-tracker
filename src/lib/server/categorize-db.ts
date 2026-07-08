import type { Database } from 'better-sqlite3';
import { normalizeMerchant, categorize, matchRule, isUnresolved, type RuleRow } from './categorizer';

export function loadRules(db: Database): RuleRow[] {
	return db
		.prepare('SELECT id, merchant, min_amount_cents, max_amount_cents, category_id FROM rules')
		.all() as RuleRow[];
}

export function loadMap(db: Database): Map<string, number> {
	return new Map(
		(
			db.prepare('SELECT plaid_key, category_id FROM plaid_category_map').all() as {
				plaid_key: string;
				category_id: number;
			}[]
		).map((r) => [r.plaid_key, r.category_id])
	);
}

export function otherCategoryId(db: Database): number {
	return db.prepare("SELECT id FROM categories WHERE name = 'Other'").pluck().get() as number;
}

/**
 * Attach every Rule's Tags to its matching Transactions (story 21) — additive
 * and idempotent: Tags the owner removed by hand can reappear only if the Rule
 * still matches, and nothing is ever detached here.
 */
// ponytail: one set-based pass over all transactions instead of per-row
// matching — trivially correct at household volume; scope by txn ids if slow.
export function applyRuleTags(db: Database): void {
	db.prepare(
		`INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id)
		 SELECT t.id, rt.tag_id
		 FROM rules r
		 JOIN rule_tags rt ON rt.rule_id = r.id
		 JOIN transactions t ON lower(t.merchant) = lower(r.merchant)
		   AND (r.min_amount_cents IS NULL OR ABS(t.amount_cents) >= r.min_amount_cents)
		   AND (r.max_amount_cents IS NULL OR ABS(t.amount_cents) <= r.max_amount_cents)`
	).run();
}

/**
 * Re-run the ladder over every Transaction whose Category the owner has not
 * hand-set (Corrections are never overwritten; approved Proposals carry the
 * same owner judgment plus their Receipt audit trail — story 18). LLM
 * assignments are respected the same way: sweeps stay deterministic and free,
 * never re-calling the model (ADR-0006, story 32).
 * Used after Rule or mapping edits; `onlySource` narrows it.
 */
export function recategorizeAll(db: Database, onlySource?: 'plaid' | 'rule'): void {
	const rules = loadRules(db);
	const map = loadMap(db);
	const fallback = otherCategoryId(db);
	const rows = db
		.prepare(
			`SELECT id, name, plaid_merchant_name, amount_cents, plaid_category_primary, plaid_category_detailed, plaid_confidence
			 FROM transactions
			 WHERE category_source NOT IN ('correction', 'proposal', 'llm', 'llm+receipt')
			 ${onlySource ? `AND category_source = '${onlySource}'` : ''}`
		)
		.all() as {
		id: number;
		name: string;
		plaid_merchant_name: string | null;
		amount_cents: number;
		plaid_category_primary: string | null;
		plaid_category_detailed: string | null;
		plaid_confidence: string | null;
	}[];
	const update = db.prepare(
		'UPDATE transactions SET merchant = ?, category_id = ?, category_source = ?, unresolved = ? WHERE id = ?'
	);
	db.transaction(() => {
		for (const r of rows) {
			const merchant = normalizeMerchant(r.name, r.plaid_merchant_name);
			const facts = {
				merchant,
				amount_cents: r.amount_cents,
				pfc_primary: r.plaid_category_primary,
				pfc_detailed: r.plaid_category_detailed
			};
			const cat = categorize(facts, rules, map);
			const unresolved = isUnresolved(facts, r.plaid_confidence, matchRule(facts, rules) !== null);
			update.run(
				merchant,
				cat?.categoryId ?? fallback,
				cat?.source ?? 'plaid',
				unresolved ? 1 : 0,
				r.id
			);
		}
		applyRuleTags(db);
	})();
}
