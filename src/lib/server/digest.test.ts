import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import { buildDigest } from './digest';

const TODAY = '2026-07-04';

// Fixture ledger planted with lookalike leak values everywhere a sloppy digest
// could pick them up: account name/mask, a beneficiary's name, and a balance.
function makeDb() {
	const db = new Database(':memory:');
	migrate(db);
	db.prepare("INSERT INTO connections (institution_name, plaid_item_id) VALUES ('LEAKY-BANK', 'i')").run();
	db.prepare(
		`INSERT INTO accounts (connection_id, plaid_account_id, name, type, subtype, mask, current_balance_cents)
		 VALUES (1, 'a1', 'LEAKY-ACCOUNT-NAME', 'depository', 'checking', '4242', 98765432)`
	).run();
	db.prepare(
		`INSERT INTO accounts (connection_id, plaid_account_id, name, type, subtype, mask, current_balance_cents)
		 VALUES (1, 'a529', 'LEAKY-529-NAME', 'investment', '529', '5299', 55555555)`
	).run();
	// 529 setup: beneficiary's name is identity and must never leave the machine
	db.prepare("INSERT INTO settings (key, value) VALUES ('529_2_name', 'LeakyName')").run();
	db.prepare("INSERT INTO settings (key, value) VALUES ('529_2_age', '10')").run();
	db.prepare("INSERT INTO settings (key, value) VALUES ('529_2_target_dollars', '100000')").run();
	db.prepare("INSERT INTO settings (key, value) VALUES ('529_2_override_monthly_dollars', '500')").run();

	let seq = 0;
	const cat = (name: string) =>
		db
			.prepare('INSERT INTO categories (name) VALUES (?) ON CONFLICT (name) DO UPDATE SET name = name RETURNING id')
			.pluck()
			.get(name) as number;
	const txn = (date: string, amount: number, merchant: string, category?: string, over: Record<string, number> = {}) =>
		db
			.prepare(
				`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, merchant, amount_cents, category_id, unresolved, is_saved, is_transfer)
				 VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				`dg-${++seq}`,
				date,
				merchant,
				merchant,
				amount,
				category ? cat(category) : null,
				over.unresolved ?? 0,
				over.is_saved ?? 0,
				over.is_transfer ?? 0
			);

	// June (the digest period): income 5000, groceries 600 (2 txns), dining 250,
	// one 400 saved transfer leg, one unresolved amazon charge 63.47
	txn('2026-06-01', 500_000, 'EMPLOYER PAYROLL', undefined);
	txn('2026-06-05', -40_000, 'WHOLE FOODS', 'Groceries');
	txn('2026-06-19', -20_000, 'WHOLE FOODS', 'Groceries');
	txn('2026-06-11', -25_000, 'NICE RESTAURANT', 'Dining');
	txn('2026-06-15', -6_347, 'AMZN Mktp US', undefined, { unresolved: 1 });
	txn('2026-06-20', -40_000, 'TRANSFER TO SAVINGS', undefined, { is_transfer: 1, is_saved: 1 });
	// May (previous month): groceries 500
	txn('2026-05-06', -50_000, 'WHOLE FOODS', 'Groceries');
	txn('2026-05-01', 500_000, 'EMPLOYER PAYROLL', undefined);

	// hygiene backlog: one open review item, two rejected
	db.prepare("INSERT INTO review_items (kind, payload) VALUES ('transfer-ambiguity', '{\"txnId\":1,\"candidateIds\":[]}')").run();
	db.prepare(
		"INSERT INTO review_items (kind, payload, status, resolved_at) VALUES ('transfer-ambiguity', '{\"txnId\":2,\"candidateIds\":[]}', 'rejected', datetime('now'))"
	).run();
	db.prepare(
		"INSERT INTO review_items (kind, payload, status, resolved_at) VALUES ('proposal', '{\"txnId\":5,\"messageId\":\"m\"}', 'rejected', datetime('now'))"
	).run();
	return db;
}

test('golden fixture ledger → expected digest figures', () => {
	const digest = buildDigest(makeDb(), '2026-06', TODAY);
	expect(digest.summary.income_dollars).toBe(5000);
	expect(digest.summary.expenses_dollars).toBe(913.47);
	expect(digest.summary.saved_dollars).toBe(400);
	expect(digest.summary.savings_rate_pct).toBe(8);
	expect(digest.previous.month).toBe('2026-05');
	expect(digest.top_categories[0]).toEqual({
		name: 'Groceries',
		spent_dollars: 600,
		prev_spent_dollars: 500
	});
	expect(digest.top_merchants[0].name).toBe('WHOLE FOODS');
	expect(digest.top_merchants[0].txn_count).toBe(2);
});

test('digest carries the data-quality counts', () => {
	const digest = buildDigest(makeDb(), '2026-06', TODAY);
	expect(digest.data_quality).toEqual({
		open_review_items: 1,
		unresolved_charges: 1,
		rejected_not_reopened: 2
	});
});

test('boundary: no account numbers, balances, Account names, or identity can appear', () => {
	const digest = buildDigest(makeDb(), '2026-06', TODAY);
	const wire = JSON.stringify(digest);
	// planted lookalikes, exactly as they'd leak
	expect(wire).not.toContain('LEAKY'); // account + institution names
	expect(wire).not.toContain('4242'); // mask
	expect(wire).not.toContain('5299'); // 529 mask
	expect(wire).not.toContain('LeakyName'); // identity
	expect(wire).not.toContain('987654'); // checking balance in any unit
	expect(wire).not.toContain('555555'); // 529 balance feeds funded_pct only
	// while the useful figures do flow
	expect(wire).toContain('Groceries');
	expect(wire).toContain('WHOLE FOODS');
});

test('529 plans surface as horizons and percentages, never balances or names', () => {
	const digest = buildDigest(makeDb(), '2026-06', TODAY);
	expect(digest.projections.education_plans).toHaveLength(1);
	const plan = digest.projections.education_plans[0];
	expect(Object.keys(plan).sort()).toEqual([
		'assumptions',
		'contribution_source',
		'funded_pct',
		'monthly_contribution_dollars',
		'years_left'
	]);
});
