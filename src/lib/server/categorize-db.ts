import type { Database } from 'better-sqlite3';
import { normalizeMerchant, categorize, matchRule, fits, isUnresolved, type RuleRow } from './categorizer';

export function loadRules(db: Database): RuleRow[] {
	return db
		.prepare('SELECT id, merchant, min_amount_cents, max_amount_cents, category_id FROM rules ORDER BY id')
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
// Matching runs in JS through the same `fits` predicate matchRule uses, so the
// two halves of Rule application fold case identically (Unicode toLowerCase, not
// SQLite's ASCII-only lower()) — a non-ASCII merchant gets both its Category and
// its Tags, never one without the other.
// ponytail: nested loop over all transactions × tagged rules — trivially correct
// at household volume; index merchant→txns or scope by txn ids if it ever drags.
export function applyRuleTags(db: Database): void {
	const tagsByRule = new Map<number, number[]>();
	for (const rt of db.prepare('SELECT rule_id, tag_id FROM rule_tags').all() as {
		rule_id: number;
		tag_id: number;
	}[])
		(tagsByRule.get(rt.rule_id) ?? tagsByRule.set(rt.rule_id, []).get(rt.rule_id)!).push(rt.tag_id);
	if (tagsByRule.size === 0) return;
	const tagged = loadRules(db).filter((r) => tagsByRule.has(r.id));
	const txns = db.prepare('SELECT id, merchant, amount_cents FROM transactions').all() as {
		id: number;
		merchant: string | null;
		amount_cents: number;
	}[];
	const attach = db.prepare(
		'INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)'
	);
	db.transaction(() => {
		for (const t of txns) {
			const merchant = (t.merchant ?? '').toLowerCase();
			const abs = Math.abs(t.amount_cents);
			for (const r of tagged)
				if (fits(r, merchant, abs))
					for (const tagId of tagsByRule.get(r.id)!) attach.run(t.id, tagId);
		}
	})();
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
