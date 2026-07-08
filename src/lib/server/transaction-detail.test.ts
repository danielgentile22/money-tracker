import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import { getTransactionDetail } from './transaction-detail';

function makeDb() {
	const db = new Database(':memory:');
	migrate(db);
	db.prepare("INSERT INTO connections (institution_name, plaid_item_id) VALUES ('B', 'i')").run();
	db.prepare(
		"INSERT INTO accounts (connection_id, plaid_account_id, name, type) VALUES (1, 'a', 'Checking', 'depository')"
	).run();
	return db;
}

function cat(db: Database.Database, name: string): number {
	return db.prepare('SELECT id FROM categories WHERE name = ?').pluck().get(name) as number;
}

function insertTxn(db: Database.Database, over: Record<string, unknown> = {}): number {
	const row = {
		plaid_transaction_id: `t-${Math.random()}`,
		date: '2026-06-15',
		name: 'SQ *BLUE BOTTLE #442',
		merchant: 'Blue Bottle',
		amount_cents: -450,
		category_id: cat(db, 'Coffee'),
		category_source: 'plaid',
		...over
	};
	const cols = Object.keys(row);
	return db
		.prepare(
			`INSERT INTO transactions (account_id, ${cols.join(', ')})
			 VALUES (1, ${cols.map(() => '?').join(', ')}) RETURNING id`
		)
		.pluck()
		.get(...Object.values(row)) as number;
}

// --- receipt section ---

test('matched receipt: email metadata + Gmail link, body never shipped', () => {
	const db = makeDb();
	const id = insertTxn(db, {
		receipt_search_state: 'matched',
		receipt_json: JSON.stringify({
			inboxAddress: 'dan@example.com',
			messageId: 'abc123',
			from: 'Blue Bottle <orders@bluebottle.com>',
			subject: 'Your order',
			date: '2026-06-15',
			snippet: 'Thanks for your order',
			body: 'SECRET-BODY-TEXT full email contents here'
		}),
		receipt_facts_json: JSON.stringify({
			description: 'two bags of coffee beans',
			vendor: 'Blue Bottle Coffee',
			items: [{ name: 'Giant Steps', price_cents: 2200 }]
		})
	});

	const d = getTransactionDetail(db, id);

	expect(d.receipt).toMatchObject({
		state: 'matched',
		email: {
			from: 'Blue Bottle <orders@bluebottle.com>',
			subject: 'Your order',
			date: '2026-06-15'
		},
		facts: { description: 'two bags of coffee beans', vendor: 'Blue Bottle Coffee' }
	});
	expect(d.receipt!.email!.gmailUrl).toContain('abc123');
	expect(d.receipt!.email!.gmailUrl).toContain(encodeURIComponent('dan@example.com'));
	expect(JSON.stringify(d)).not.toContain('SECRET-BODY-TEXT');
});

// --- provenance: category, Plaid signal, rules-that-apply-now ---

test('provenance: source, Plaid raw signal, matching Rules with winner and drift', () => {
	const db = makeDb();
	db.prepare('INSERT INTO rules (merchant, category_id) VALUES (?, ?)').run(
		'Blue Bottle',
		cat(db, 'Coffee')
	);
	db.prepare(
		'INSERT INTO rules (merchant, min_amount_cents, max_amount_cents, category_id) VALUES (?, 400, 500, ?)'
	).run('Blue Bottle', cat(db, 'Gifts'));
	const id = insertTxn(db, {
		category_id: cat(db, 'Gifts'),
		category_source: 'rule',
		plaid_category_primary: 'FOOD_AND_DRINK',
		plaid_category_detailed: 'FOOD_AND_DRINK_COFFEE',
		plaid_confidence: 'HIGH'
	});

	const d = getTransactionDetail(db, id);

	expect(d.category).toMatchObject({ name: 'Gifts', source: 'rule' });
	expect(d.plaid).toEqual({
		primary: 'FOOD_AND_DRINK',
		detailed: 'FOOD_AND_DRINK_COFFEE',
		confidence: 'HIGH'
	});
	expect(d.rules!.matches.map((m) => m.category_name)).toEqual(['Coffee', 'Gifts']);
	expect(d.rules!.matches.find((m) => m.id === d.rules!.winnerId)!.category_name).toBe('Gifts');
	expect(d.rules!.drifted).toBe(false);
});

// --- edge rows ---

test('Transfer: paired leg shown, receipt and rules sections absent', () => {
	const db = makeDb();
	db.prepare(
		"INSERT INTO accounts (connection_id, plaid_account_id, name, type) VALUES (1, 'b', 'Savings', 'depository')"
	).run();
	const out = insertTxn(db, {
		name: 'Online Transfer to SAV',
		merchant: 'Online Transfer',
		amount_cents: -50000,
		is_transfer: 1,
		category_id: null,
		category_source: null
	});
	const inn = db
		.prepare(
			`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, amount_cents, is_transfer, transfer_peer_id)
			 VALUES (2, 't-in', '2026-06-15', 'Transfer from CHK', 50000, 1, ?) RETURNING id`
		)
		.pluck()
		.get(out) as number;
	db.prepare('UPDATE transactions SET transfer_peer_id = ? WHERE id = ?').run(inn, out);

	const d = getTransactionDetail(db, out);

	expect(d.transferPeer).toMatchObject({
		id: inn,
		account_name: 'Savings',
		amount_cents: 50000,
		date: '2026-06-15'
	});
	expect(d.receipt).toBeNull();
	expect(d.rules).toBeNull();
});

test('non-Transfer never-searched charge: "not searched" receipt, no peer', () => {
	const db = makeDb();
	const id = insertTxn(db);

	const d = getTransactionDetail(db, id);

	expect(d.transferPeer).toBeNull();
	expect(d.receipt).toEqual({ state: 'not-searched', email: null, facts: null });
});

test('recurring charge carries its series chip; tags ride along', () => {
	const db = makeDb();
	const seriesId = db
		.prepare(
			`INSERT INTO recurring_series (merchant, cadence, typical_amount_cents, last_amount_cents, first_seen, last_seen)
			 VALUES ('Netflix', 'monthly', 1599, 1599, '2026-01-05', '2026-06-05') RETURNING id`
		)
		.pluck()
		.get() as number;
	const id = insertTxn(db, { merchant: 'Netflix', recurring_series_id: seriesId });
	const tagId = db
		.prepare("INSERT INTO tags (name) VALUES ('streaming') RETURNING id")
		.pluck()
		.get() as number;
	db.prepare('INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)').run(id, tagId);

	const d = getTransactionDetail(db, id);

	expect(d.recurring).toMatchObject({ cadence: 'monthly', typical_amount_cents: 1599 });
	expect(d.tags).toEqual([{ id: tagId, name: 'streaming' }]);
});
