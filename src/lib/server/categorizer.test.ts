import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import { recategorizeAll } from './categorize-db';
import {
	normalizeMerchant,
	matchRule,
	categorize,
	isUnresolved,
	explainRules,
	type RuleRow,
	type TxnFacts
} from './categorizer';

const facts = (over: Partial<TxnFacts> = {}): TxnFacts => ({
	merchant: 'Blue Bottle',
	amount_cents: -450,
	pfc_primary: 'FOOD_AND_DRINK',
	pfc_detailed: 'FOOD_AND_DRINK_COFFEE',
	...over
});

const rule = (over: Partial<RuleRow> = {}): RuleRow => ({
	id: 1,
	merchant: 'Blue Bottle',
	min_amount_cents: null,
	max_amount_cents: null,
	category_id: 42,
	...over
});

// --- normalizeMerchant ---

test('Plaid merchant_name wins over the raw string', () => {
	expect(normalizeMerchant('SQ *BLUE BOTTLE #442 OAK', 'Blue Bottle Coffee')).toBe(
		'Blue Bottle Coffee'
	);
});

test('processor prefixes and store numbers are stripped', () => {
	expect(normalizeMerchant('SQ *BLUE BOTTLE', null)).toBe('BLUE BOTTLE');
	expect(normalizeMerchant('TST* FANCY RESTAURANT', null)).toBe('FANCY RESTAURANT');
	expect(normalizeMerchant('STARBUCKS #12345', null)).toBe('STARBUCKS');
	expect(normalizeMerchant('WALGREENS  6034', null)).toBe('WALGREENS');
});

test('same payee with noise variants normalizes to one Merchant', () => {
	const variants = ['SQ *JOES PIZZA', 'SQ * JOES PIZZA', 'JOES PIZZA #22', 'JOES PIZZA 4471'];
	const normalized = new Set(variants.map((v) => normalizeMerchant(v, null)));
	expect(normalized).toEqual(new Set(['JOES PIZZA']));
});

// --- ladder precedence ---

test('a Rule beats the Plaid mapping', () => {
	const map = new Map([['FOOD_AND_DRINK_COFFEE', 3]]);
	expect(categorize(facts(), [rule({ category_id: 42 })], map)).toEqual({
		categoryId: 42,
		source: 'rule'
	});
});

test('Rule matching is case-insensitive on the Merchant', () => {
	expect(matchRule(facts({ merchant: 'BLUE BOTTLE' }), [rule()])).not.toBeNull();
});

test('detailed mapping beats primary; unmapped falls to null', () => {
	const map = new Map([
		['FOOD_AND_DRINK', 5],
		['FOOD_AND_DRINK_COFFEE', 3]
	]);
	expect(categorize(facts(), [], map)).toEqual({ categoryId: 3, source: 'plaid' });
	expect(categorize(facts({ pfc_detailed: 'FOOD_AND_DRINK_RESTAURANT' }), [], map)).toEqual({
		categoryId: 5,
		source: 'plaid'
	});
	expect(categorize(facts({ pfc_primary: 'NOPE', pfc_detailed: null }), [], new Map())).toBeNull();
});

// --- amount-range Rules ---

test('a ranged Rule matches only inside its absolute range', () => {
	const ranged = [rule({ min_amount_cents: 400, max_amount_cents: 500 })];
	expect(matchRule(facts({ amount_cents: -450 }), ranged)).not.toBeNull();
	expect(matchRule(facts({ amount_cents: -600 }), ranged)).toBeNull();
	expect(matchRule(facts({ amount_cents: -300 }), ranged)).toBeNull();
});

test('a ranged Rule is preferred over an unranged one for the same Merchant', () => {
	const both = [
		rule({ id: 1, category_id: 10 }),
		rule({ id: 2, category_id: 20, min_amount_cents: 400, max_amount_cents: 500 })
	];
	expect(matchRule(facts({ amount_cents: -450 }), both)?.category_id).toBe(20);
	expect(matchRule(facts({ amount_cents: -900 }), both)?.category_id).toBe(10);
});

test('the narrowest range wins — and it wins regardless of Rule order', () => {
	const wide = rule({ id: 1, category_id: 10, min_amount_cents: 100, max_amount_cents: 900 });
	const narrow = rule({ id: 2, category_id: 20, min_amount_cents: 400, max_amount_cents: 500 });
	// both fit -450; narrow (span 100) beats wide (span 800) either way round
	expect(matchRule(facts({ amount_cents: -450 }), [wide, narrow])?.category_id).toBe(20);
	expect(matchRule(facts({ amount_cents: -450 }), [narrow, wide])?.category_id).toBe(20);
});

test('two equally-specific overlapping Rules resolve by lowest id, not array order', () => {
	const a = rule({ id: 7, category_id: 10, min_amount_cents: 400, max_amount_cents: 500 });
	const b = rule({ id: 3, category_id: 20, min_amount_cents: 400, max_amount_cents: 500 });
	expect(matchRule(facts({ amount_cents: -450 }), [a, b])?.category_id).toBe(20); // id 3 < 7
	expect(matchRule(facts({ amount_cents: -450 }), [b, a])?.category_id).toBe(20);
});

test('a half-open ranged Rule still beats a fully unranged one', () => {
	const open = rule({ id: 1, category_id: 10 }); // unranged
	const halfOpen = rule({ id: 2, category_id: 20, min_amount_cents: 400, max_amount_cents: null });
	expect(matchRule(facts({ amount_cents: -450 }), [open, halfOpen])?.category_id).toBe(20);
});

// --- Unresolved (CONTEXT.md definition, both branches) ---

test('no Rule + confidence below HIGH → Unresolved', () => {
	expect(isUnresolved(facts(), 'MEDIUM', false)).toBe(true);
	expect(isUnresolved(facts(), null, false)).toBe(true);
});

test('no Rule + HIGH confidence + normal Merchant → resolved', () => {
	expect(isUnresolved(facts(), 'HIGH', false)).toBe(false);
	expect(isUnresolved(facts(), 'VERY_HIGH', false)).toBe(false);
});

test('ambiguous payee is Unresolved even at HIGH confidence', () => {
	expect(isUnresolved(facts({ merchant: 'Amazon' }), 'VERY_HIGH', false)).toBe(true);
	expect(isUnresolved(facts({ merchant: 'PAYPAL *SELLER' }), 'HIGH', false)).toBe(true);
	expect(isUnresolved(facts({ merchant: 'Venmo' }), 'HIGH', false)).toBe(true);
});

test('a Rule match resolves regardless of confidence or payee', () => {
	expect(isUnresolved(facts({ merchant: 'Amazon' }), 'LOW', true)).toBe(false);
});

// --- re-application skips correction-source rows ---

test('recategorizeAll updates plaid/rule rows but never corrections', () => {
	const db = new Database(':memory:');
	migrate(db);
	db.prepare("INSERT INTO connections (institution_name, plaid_item_id) VALUES ('B', 'i')").run();
	db.prepare(
		"INSERT INTO accounts (connection_id, plaid_account_id, name, type) VALUES (1, 'a', 'Checking', 'depository')"
	).run();
	const coffee = db.prepare("SELECT id FROM categories WHERE name = 'Coffee'").pluck().get();
	const gifts = db.prepare("SELECT id FROM categories WHERE name = 'Gifts'").pluck().get();
	const insert = db.prepare(
		`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, amount_cents, merchant, category_id, category_source, plaid_category_primary, plaid_category_detailed)
		 VALUES (1, ?, '2026-06-01', ?, -450, ?, ?, ?, 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_COFFEE')`
	);
	insert.run('t-plaid', 'BLUE BOTTLE', 'BLUE BOTTLE', coffee, 'plaid');
	insert.run('t-corrected', 'BLUE BOTTLE', 'BLUE BOTTLE', gifts, 'correction');
	// a new Rule now maps Blue Bottle → Gifts
	db.prepare('INSERT INTO rules (merchant, category_id) VALUES (?, ?)').run('BLUE BOTTLE', gifts);

	recategorizeAll(db);

	const rows = db
		.prepare('SELECT plaid_transaction_id AS pid, category_id, category_source FROM transactions ORDER BY pid')
		.all() as { pid: string; category_id: number; category_source: string }[];
	expect(rows).toEqual([
		{ pid: 't-corrected', category_id: gifts, category_source: 'correction' },
		{ pid: 't-plaid', category_id: gifts, category_source: 'rule' }
	]);
});

// --- explainRules: the detail view's "rules that apply" (always answers *now*) ---

test('explainRules lists all matching Rules with the ranged winner marked', () => {
	const unranged = rule({ id: 1, category_id: 42 });
	const ranged = rule({ id: 2, min_amount_cents: 400, max_amount_cents: 500, category_id: 7 });
	const other = rule({ id: 3, merchant: 'Philz', category_id: 9 });

	const explained = explainRules(facts(), [unranged, ranged, other], {
		categoryId: 7,
		source: 'rule'
	});

	expect(explained.matches.map((r) => r.id)).toEqual([1, 2]);
	expect(explained.winnerId).toBe(2);
	expect(explained.drifted).toBe(false);
});

test('drift: rule-sourced Category no current Rule explains → drifted', () => {
	// categorized by a Rule last month; that Rule has since been retargeted
	const retargeted = rule({ id: 1, category_id: 99 });
	const explained = explainRules(facts(), [retargeted], { categoryId: 7, source: 'rule' });
	expect(explained.drifted).toBe(true);

	// ...or deleted outright
	const gone = explainRules(facts(), [], { categoryId: 7, source: 'rule' });
	expect(gone.matches).toEqual([]);
	expect(gone.winnerId).toBeNull();
	expect(gone.drifted).toBe(true);
});

test('drift never fires for non-rule sources, even with zero matches', () => {
	expect(explainRules(facts(), [], { categoryId: 7, source: 'plaid' }).drifted).toBe(false);
	expect(explainRules(facts(), [], { categoryId: null, source: null }).drifted).toBe(false);
});
