// SQL compilation stays server-side; the pure FilterSet vocabulary (types,
// parse, serialize, preset resolution) lives in $lib/filters so the filter
// bar speaks the same language in the browser.
import { resolveDateRange, type FilterSet, type IdFilter } from '../filters';

export * from '../filters';

/**
 * Compile a FilterSet to WHERE clauses on transactions alias `t`. The ADR-0003
 * baseline holds in every compiled query: investment activity is invisible.
 * (Transfer exclusion is the aggregate engines' job — the ledger lists them.)
 */
export function compileFilters(
	f: FilterSet,
	today: string
): { clauses: string[]; params: (string | number)[] } {
	const clauses: string[] = ['t.is_investment_activity = 0'];
	const params: (string | number)[] = [];
	const marks = (n: number) => Array(n).fill('?').join(',');

	const idClause = (v: IdFilter | undefined, col: string) => {
		if (v?.include?.length) {
			clauses.push(`${col} IN (${marks(v.include.length)})`);
			params.push(...v.include);
		}
		if (v?.exclude?.length) {
			// NULL guard: uncategorized rows survive a category/group exclude
			clauses.push(`(${col} IS NULL OR ${col} NOT IN (${marks(v.exclude.length)}))`);
			params.push(...v.exclude);
		}
	};
	idClause(f.categories, 't.category_id');
	idClause(f.accounts, 't.account_id');
	// Group filters resolve through each Category's Group
	if (f.groups?.include?.length) {
		clauses.push(
			`t.category_id IN (SELECT id FROM categories WHERE group_id IN (${marks(f.groups.include.length)}))`
		);
		params.push(...f.groups.include);
	}
	if (f.groups?.exclude?.length) {
		clauses.push(
			`(t.category_id IS NULL OR t.category_id NOT IN (SELECT id FROM categories WHERE group_id IN (${marks(f.groups.exclude.length)})))`
		);
		params.push(...f.groups.exclude);
	}
	if (f.tags?.include?.length) {
		clauses.push(
			`EXISTS (SELECT 1 FROM transaction_tags tt WHERE tt.transaction_id = t.id AND tt.tag_id IN (${marks(f.tags.include.length)}))`
		);
		params.push(...f.tags.include);
	}
	if (f.tags?.exclude?.length) {
		// exclude = has none of these Tags
		clauses.push(
			`NOT EXISTS (SELECT 1 FROM transaction_tags tt WHERE tt.transaction_id = t.id AND tt.tag_id IN (${marks(f.tags.exclude.length)}))`
		);
		params.push(...f.tags.exclude);
	}
	// merchant identity = what the ledger shows: normalized merchant, name fallback
	if (f.merchants?.include?.length) {
		clauses.push(`COALESCE(t.merchant, t.name) COLLATE NOCASE IN (${marks(f.merchants.include.length)})`);
		params.push(...f.merchants.include);
	}
	if (f.merchants?.exclude?.length) {
		clauses.push(
			`COALESCE(t.merchant, t.name) COLLATE NOCASE NOT IN (${marks(f.merchants.exclude.length)})`
		);
		params.push(...f.merchants.exclude);
	}
	const { from, to } = resolveDateRange(f.date, today);
	if (from) (clauses.push('t.date >= ?'), params.push(from));
	if (to) (clauses.push('t.date <= ?'), params.push(to));
	return { clauses, params };
}
