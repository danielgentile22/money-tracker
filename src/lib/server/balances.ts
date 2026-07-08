import type { Database } from 'better-sqlite3';

// Snapshots are the truth for net worth going forward; history before day 1
// is reconstructed backwards through Transactions for cash Accounts only and
// marked estimated. Investment Accounts start honestly at day 1 (prices move
// without Transactions).

export function localToday(): string {
	return new Date().toLocaleDateString('en-CA'); // yyyy-mm-dd, local tz
}

/** One real Snapshot per Account per sync; same-day re-sync updates in place. */
export function recordSnapshots(db: Database, date = localToday()): void {
	const accounts = db
		.prepare('SELECT id, current_balance_cents FROM accounts WHERE current_balance_cents IS NOT NULL')
		.all() as { id: number; current_balance_cents: number }[];
	const upsert = db.prepare(
		`INSERT INTO snapshots (account_id, date, balance_cents, estimated) VALUES (?, ?, ?, 0)
		 ON CONFLICT (account_id, date) DO UPDATE SET balance_cents = excluded.balance_cents, estimated = 0`
	);
	db.transaction(() => {
		for (const a of accounts) upsert.run(a.id, date, a.current_balance_cents);
	})();
}

/**
 * Rebuild the estimated region for every cash Account: anchor at the earliest
 * real Snapshot and walk backwards through posted Transactions
 * (balance(d) = anchor − Σ amounts dated after d). Deletes and regenerates the
 * estimated rows, so it is safe to run after every sync as history deepens.
 */
export function reconstructHistory(db: Database): void {
	const accounts = db
		.prepare("SELECT id FROM accounts WHERE type != 'investment'")
		.all() as { id: number }[];
	db.transaction(() => {
		for (const a of accounts) reconstructAccount(db, a.id);
	})();
}

function reconstructAccount(db: Database, accountId: number): void {
	const anchor = db
		.prepare(
			'SELECT date, balance_cents FROM snapshots WHERE account_id = ? AND estimated = 0 ORDER BY date LIMIT 1'
		)
		.get(accountId) as { date: string; balance_cents: number } | undefined;
	if (!anchor) return;

	const txns = db
		.prepare(
			'SELECT date, amount_cents FROM transactions WHERE account_id = ? AND pending = 0 AND date <= ? ORDER BY date'
		)
		.all(accountId, anchor.date) as { date: string; amount_cents: number }[];

	db.prepare('DELETE FROM snapshots WHERE account_id = ? AND estimated = 1').run(accountId);
	if (txns.length === 0) return;

	// daily balances from the eve of the first Transaction up to the day before day 1
	const insert = db.prepare(
		'INSERT INTO snapshots (account_id, date, balance_cents, estimated) VALUES (?, ?, ?, 1)'
	);
	const anchorMs = Date.parse(anchor.date);
	const startMs = Date.parse(txns[0].date) - 86_400_000;
	for (let ms = startMs; ms < anchorMs; ms += 86_400_000) {
		const day = new Date(ms).toISOString().slice(0, 10);
		const after = txns.filter((t) => t.date > day).reduce((sum, t) => sum + t.amount_cents, 0);
		insert.run(accountId, day, anchor.balance_cents - after);
	}
}

export type SeriesPoint = { date: string; balance_cents: number; estimated: number };

export function balanceSeries(db: Database, accountId: number): SeriesPoint[] {
	return db
		.prepare(
			'SELECT date, balance_cents, estimated FROM snapshots WHERE account_id = ? ORDER BY date'
		)
		.all(accountId) as SeriesPoint[];
}

/**
 * Net worth per Snapshot date: every Account's last known balance summed
 * (liabilities are stored negative, so plain addition is correct). Accounts
 * missing a Snapshot on a date carry their previous balance forward; a date
 * is estimated when any contributing balance is. Session 3's net-worth tab
 * passes accountIds to watch a subset in isolation.
 */
export function netWorthSeries(db: Database, accountIds?: number[]): SeriesPoint[] {
	if (accountIds?.length === 0) return [];
	const scope = accountIds ? ` WHERE account_id IN (${accountIds.map(() => '?').join(',')})` : '';
	const rows = db
		.prepare(`SELECT account_id, date, balance_cents, estimated FROM snapshots${scope} ORDER BY date`)
		.all(...(accountIds ?? [])) as (SeriesPoint & { account_id: number })[];
	const last = new Map<number, { balance_cents: number; estimated: number }>();
	const out: SeriesPoint[] = [];
	for (let i = 0; i < rows.length; i++) {
		last.set(rows[i].account_id, rows[i]);
		if (i + 1 < rows.length && rows[i + 1].date === rows[i].date) continue; // date not finished
		let sum = 0;
		let estimated = 0;
		for (const b of last.values()) {
			sum += b.balance_cents;
			estimated ||= b.estimated;
		}
		out.push({ date: rows[i].date, balance_cents: sum, estimated });
	}
	return out;
}
