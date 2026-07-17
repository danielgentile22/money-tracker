// Cost Split usage engine: attribute each subscription charge's period to
// matched projects by usage cost. Data comes from the ccusage CLI behind the
// UsageFetch seam — tests use canned JSON, the real one shells out on demand.

import type { Database } from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

// This feature owns its schema instead of joining the migration chain: these
// idempotent statements run when the /splits route module loads, so a fresh
// install creates the tables on first visit and all access stays behind this
// route. Schema changes must be additive (new IF-NOT-EXISTS statements), never
// ALTERs. Full rationale: docs/adr/0010-splits-schema-outside-migration-chain.md
export function ensureSplitSchema(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS split_charges (
		  id INTEGER PRIMARY KEY,
		  provider TEXT NOT NULL,          -- e.g. 'claude', 'codex'
		  date TEXT NOT NULL,              -- yyyy-mm-dd
		  amount_cents INTEGER NOT NULL,
		  note TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_split_charges_provider_date
		  ON split_charges (provider, date);

		-- One row per computed period, keyed by the charge that opens it.
		CREATE TABLE IF NOT EXISTS split_periods (
		  charge_id INTEGER PRIMARY KEY REFERENCES split_charges(id) ON DELETE CASCADE,
		  matched_cost REAL NOT NULL,      -- usage dollars in matched projects
		  total_cost REAL NOT NULL,        -- usage dollars across all projects
		  attributable_cents INTEGER NOT NULL, -- round(charge * matched/total)
		  frozen INTEGER NOT NULL DEFAULT 0,   -- 1 once the period is closed and computed
		  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		-- Partner repayments: manual ledger, optionally linked to a bank transaction.
		CREATE TABLE IF NOT EXISTS split_payments (
		  id INTEGER PRIMARY KEY,
		  date TEXT NOT NULL,              -- yyyy-mm-dd
		  amount_cents INTEGER NOT NULL,
		  transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
		  note TEXT
		);
		-- a bank transaction is one repayment, ever — double-submit can't count it twice
		CREATE UNIQUE INDEX IF NOT EXISTS idx_split_payments_transaction
		  ON split_payments (transaction_id);
	`);
}

export type UsageDay = { date: string; totalCost: number };
export type UsageJson = { projects: Record<string, UsageDay[]> };
export type UsageFetch = (provider: string, since: string, until: string | null) => Promise<UsageJson>;

/** Shells out to the ccusage CLI — the exact-pinned devDependency's local
 * binary, never `npx -y ccusage@latest` (unpinned remote code + network
 * egress, both barred by ADR-0001). Window filtering stays in computeShare,
 * so the extra day --until fetches (it's inclusive) never leaks into a period. */
export const realUsageFetch: UsageFetch = async (provider, since, until) => {
	const args = [
		provider,
		'daily',
		'--since',
		since.replaceAll('-', ''),
		...(until ? ['--until', until.replaceAll('-', '')] : []),
		'--instances',
		'--json'
	];
	// ponytail: cwd-relative bin — dev server always runs from the repo root
	const { stdout } = await promisify(execFile)(join(process.cwd(), 'node_modules', '.bin', 'ccusage'), args, {
		timeout: 120_000,
		maxBuffer: 64 * 1024 * 1024
	});
	return JSON.parse(stdout) as UsageJson;
};

/** Matched vs total usage dollars in [from, to) — to = null means open-ended. */
export function computeShare(
	usage: UsageJson,
	pattern: string,
	from: string,
	to: string | null
): { matched: number; total: number } {
	const p = pattern.toLowerCase();
	let matched = 0;
	let total = 0;
	for (const [project, days] of Object.entries(usage.projects)) {
		const isMatch = p !== '' && project.toLowerCase().includes(p);
		for (const d of days) {
			if (d.date < from || (to !== null && d.date >= to)) continue;
			total += d.totalCost;
			if (isMatch) matched += d.totalCost;
		}
	}
	return { matched, total };
}

export type PeriodView = {
	chargeId: number;
	from: string;
	to: string | null; // null = open (latest charge, still accruing)
	amountCents: number;
	note: string | null;
	matchedCost: number;
	totalCost: number;
	attributableCents: number;
	frozen: boolean;
	computedAt: string;
};

type ChargeRow = { id: number; date: string; amount_cents: number; note: string | null };
type PeriodRow = {
	charge_id: number;
	matched_cost: number;
	total_cost: number;
	attributable_cents: number;
	frozen: number;
	computed_at: string;
};

// Charges within a provider are totally ordered by (date, id) — every window,
// neighbor lookup, and invalidation below leans on this one ordering.

/** The frozen result of the period *preceding* a charge is stale whenever that
 * charge appears or disappears (its window's end moved) — drop it so the next
 * load recomputes. Call on add (backdated entries included) and on delete. */
export function invalidatePeriodBefore(
	db: Database,
	provider: string,
	date: string,
	id: number
): void {
	db.prepare(
		`DELETE FROM split_periods WHERE charge_id = (
		   SELECT id FROM split_charges WHERE provider = ? AND (date < ? OR (date = ? AND id < ?))
		   ORDER BY date DESC, id DESC LIMIT 1)`
	).run(provider, date, date, id);
}

function savePeriod(
	db: Database,
	charge: ChargeRow,
	usage: UsageJson,
	pattern: string,
	to: string | null,
	now: Date
): PeriodRow {
	const { matched, total } = computeShare(usage, pattern, charge.date, to);
	const row: PeriodRow = {
		charge_id: charge.id,
		matched_cost: matched,
		total_cost: total,
		attributable_cents: total > 0 ? Math.round((charge.amount_cents * matched) / total) : 0,
		frozen: to === null ? 0 : 1,
		computed_at: now.toISOString()
	};
	db.prepare(
		`INSERT OR REPLACE INTO split_periods
		 (charge_id, matched_cost, total_cost, attributable_cents, frozen, computed_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
	).run(row.charge_id, row.matched_cost, row.total_cost, row.attributable_cents, row.frozen, row.computed_at);
	return row;
}

const OPEN_CACHE_MS = 60 * 60 * 1000; // ~1h; per-period Recompute button forces

/**
 * All periods for a provider, oldest first. Closed periods are computed once
 * and frozen; the open period is recomputed when its cache is older than ~1h.
 * All stale periods share ONE fetch spanning their whole range. A failed fetch
 * degrades instead of throwing: cached rows still render, `error` says why the
 * rest couldn't.
 */
export async function periodViews(
	db: Database,
	provider: string,
	pattern: string,
	fetch: UsageFetch,
	now: Date
): Promise<{ views: PeriodView[]; error: string | null }> {
	const charges = db
		.prepare('SELECT id, date, amount_cents, note FROM split_charges WHERE provider = ? ORDER BY date, id')
		.all(provider) as ChargeRow[];
	const saved = new Map(
		(db
			.prepare(
				`SELECT p.* FROM split_periods p
				 JOIN split_charges c ON c.id = p.charge_id WHERE c.provider = ?`
			)
			.all(provider) as PeriodRow[]).map((r) => [r.charge_id, r])
	);

	const periods = charges.map((charge, i) => ({
		charge,
		to: i + 1 < charges.length ? charges[i + 1].date : null
	}));
	const stale = periods.filter(({ charge, to }) => {
		const row = saved.get(charge.id);
		return (
			!row ||
			(row.frozen === 0 &&
				(to !== null || now.getTime() - new Date(row.computed_at).getTime() > OPEN_CACHE_MS))
		);
	});

	let error: string | null = null;
	if (stale.length > 0) {
		try {
			const usage = await fetch(provider, stale[0].charge.date, stale[stale.length - 1].to);
			for (const { charge, to } of stale)
				saved.set(charge.id, savePeriod(db, charge, usage, pattern, to, now));
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	const views: PeriodView[] = [];
	for (const { charge, to } of periods) {
		const r = saved.get(charge.id);
		if (!r) continue; // never computed and the fetch failed — `error` explains
		views.push({
			chargeId: charge.id,
			from: charge.date,
			to,
			amountCents: charge.amount_cents,
			note: charge.note,
			matchedCost: r.matched_cost,
			totalCost: r.total_cost,
			attributableCents: r.attributable_cents,
			frozen: r.frozen === 1,
			computedAt: r.computed_at
		});
	}
	return { views, error };
}

/** Force-refresh one period (the Recompute button), refreezing it if closed. */
export async function recomputePeriod(
	db: Database,
	chargeId: number,
	pattern: string,
	fetch: UsageFetch,
	now: Date
): Promise<void> {
	const charge = db
		.prepare('SELECT id, provider, date, amount_cents, note FROM split_charges WHERE id = ?')
		.get(chargeId) as (ChargeRow & { provider: string }) | undefined;
	if (!charge) throw new Error('no such charge');
	const to = db
		.prepare('SELECT MIN(date) FROM split_charges WHERE provider = ? AND (date > ? OR (date = ? AND id > ?))')
		.pluck()
		.get(charge.provider, charge.date, charge.date, charge.id) as string | null;
	savePeriod(db, charge, await fetch(charge.provider, charge.date, to), pattern, to, now);
}

export type SplitSummary = {
	chargedCents: number;
	attributableCents: number;
	owedCents: number;
	paidCents: number;
	outstandingCents: number;
};

/** Totals over closed (frozen) periods only — the open period is provisional. */
export function splitSummary(db: Database, sharePct: number): SplitSummary {
	const t = db
		.prepare(
			`SELECT COALESCE(SUM(c.amount_cents), 0) AS charged,
			        COALESCE(SUM(p.attributable_cents), 0) AS attributable
			 FROM split_periods p JOIN split_charges c ON c.id = p.charge_id
			 WHERE p.frozen = 1`
		)
		.get() as { charged: number; attributable: number };
	const paid = db
		.prepare('SELECT COALESCE(SUM(amount_cents), 0) FROM split_payments')
		.pluck()
		.get() as number;
	const owed = Math.round((t.attributable * sharePct) / 100);
	return {
		chargedCents: t.charged,
		attributableCents: t.attributable,
		owedCents: owed,
		paidCents: paid,
		outstandingCents: owed - paid
	};
}

/** The owner-named sidebar/page label — one reader for every nav surface. */
export function splitDisplayName(db: Database): string {
	return (
		(db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get('split_display_name') as
			| string
			| undefined) || 'Splits'
	);
}
