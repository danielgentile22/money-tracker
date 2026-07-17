import Database from 'better-sqlite3';
import { migrate } from '$lib/server/db/migrate';

// Shared server-test fixture (#36) — the makeDb every test file used to
// redefine. Lives in src/test (not $lib) so it never ships. Migrate test
// files opportunistically; local variants can coexist during transition.

/** In-memory migrated DB with one connection and the given accounts (default: one Checking). */
export function makeDb(opts: { accounts?: { name: string; type?: string }[] } = {}) {
	const db = new Database(':memory:');
	migrate(db);
	db.prepare(
		"INSERT INTO connections (institution_name, plaid_item_id) VALUES ('Test Bank', 'item-1')"
	).run();
	const accounts = opts.accounts ?? [{ name: 'Checking' }];
	const ins = db.prepare(
		'INSERT INTO accounts (connection_id, plaid_account_id, name, type) VALUES (1, ?, ?, ?)'
	);
	accounts.forEach((a, i) => ins.run(`a${i + 1}`, a.name, a.type ?? 'depository'));
	return db;
}

let txnSeq = 0;

/** Insert a transaction; unnamed columns get sane defaults. Returns the row id. */
export function insertTxn(
	db: Database.Database,
	txn: { date: string; amount_cents: number } & Record<string, unknown>
): number {
	const row: Record<string, unknown> = {
		account_id: 1,
		plaid_transaction_id: `fixture-t${++txnSeq}`,
		name: (txn.merchant as string) ?? 'TEST TXN',
		is_investment_activity: 0,
		...txn
	};
	const cols = Object.keys(row);
	const info = db
		.prepare(`INSERT INTO transactions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
		.run(...cols.map((c) => row[c]));
	return Number(info.lastInsertRowid);
}

/** id of a seeded default category by name (e.g. 'Coffee', 'Dining'). */
export function categoryId(db: Database.Database, name: string): number {
	return db.prepare('SELECT id FROM categories WHERE name = ?').pluck().get(name) as number;
}
