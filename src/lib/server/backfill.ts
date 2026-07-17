import type { Database } from 'better-sqlite3';
import type { ReceiptSource } from './gmail';
import type { Llm } from './llm';
import { runLlmCategorization } from './llm-categorizer';
import { enrichTransaction } from './receipt-extractor';
import { triggerLookup } from './resolution';
import { isSyncing } from './sync-runner';
import { getSetting, putSetting } from './settings';

// Settings scans (the catch-up the per-sync pipeline never does), each with an
// 'all' | 'month' scope:
//  - categorization scan: every model-decidable Transaction through the batched
//    unified categorizer (Rules and Corrections never touched)
//  - receipt scan: a Gmail receipt search per posted spend charge, age gate
//    ignored; fresh matches get enriched and re-categorized
// Progress lives in settings as JSON so the page can poll a real bar.

let running = false;

export function isBackfilling(): boolean {
	return running;
}

export type ScanProgress = { label: string; done: number; total: number };

export function backfillProgress(db: Database): ScanProgress | null {
	const raw = getSetting(db, 'backfill_progress');
	if (!raw) return null;
	try {
		return JSON.parse(raw) as ScanProgress;
	} catch {
		return { label: raw, done: 0, total: 0 }; // pre-split plain-string progress
	}
}

function progress(db: Database, label: string, done = 0, total = 0): void {
	putSetting(db, 'backfill_progress', JSON.stringify({ label, done, total }));
}

/** A Gmail scan needs at least one live inbox — otherwise every "no match" is a lie. */
export function hasConnectedInbox(db: Database): boolean {
	return !!db.prepare("SELECT 1 FROM inboxes WHERE status = 'connected' LIMIT 1").pluck().get();
}

/** #81: a crash mid-scan must not leave a half-full bar as the 'last scan' record. */
function markInterrupted(db: Database): void {
	const p = backfillProgress(db);
	progress(db, `interrupted — ${p?.done ?? 0}/${p?.total ?? 0}`, p?.done ?? 0, p?.total ?? 0);
}

const TERMINAL = /^(done|interrupted|no connected inbox)/;

/**
 * #81 boot reconcile: a hard kill (SIGKILL, power loss) never runs the in-process
 * catch, so a mid-scan progress row survives the restart. No scan can be running
 * in a freshly booted process, so any non-terminal row is by definition stale.
 */
export function reconcileBackfillProgress(db: Database): void {
	const p = backfillProgress(db);
	if (p && !TERMINAL.test(p.label)) markInterrupted(db);
}

/** The scan track record Settings shows: charges by receipt_search_state. */
export function receiptScanStats(db: Database): Record<string, number> {
	const rows = db
		.prepare(
			`SELECT COALESCE(receipt_search_state, 'never') AS s, COUNT(*) AS n FROM transactions
			 WHERE pending = 0 AND is_transfer = 0 AND is_investment_activity = 0 AND amount_cents < 0
			 GROUP BY s`
		)
		.all() as { s: string; n: number }[];
	return Object.fromEntries(rows.map((r) => [r.s, r.n]));
}

const monthWindow = (scope: 'all' | 'month') =>
	scope === 'month' ? "AND date >= date('now', '-1 month')" : '';

// The scans' WHERE fragments, shared with scanCounts so the Settings confirm
// popup counts exactly what a run would touch (#17).
const CATEGORIZE_WHERE = `category_source IN ('plaid', 'llm', 'llm+receipt')
   AND is_transfer = 0 AND is_investment_activity = 0`;
const SEARCH_WHERE = `pending = 0 AND is_transfer = 0 AND is_investment_activity = 0
   AND amount_cents < 0`;
// 'month' only revisits not-yet-matched charges; 'all' redoes everything
const searchScope = (scope: 'all' | 'month') =>
	`${monthWindow(scope)}${scope === 'month' ? " AND (receipt_search_state IS NULL OR receipt_search_state != 'matched')" : ''}`;

/** What each scan button would touch — same WHERE fragments the scans run. */
export function scanCounts(db: Database, scope: 'all' | 'month'): { categorize: number; search: number } {
	const count = (where: string) =>
		db.prepare(`SELECT COUNT(*) FROM transactions WHERE ${where}`).pluck().get() as number;
	return {
		categorize: count(`${CATEGORIZE_WHERE} ${monthWindow(scope)}`),
		search: count(`${SEARCH_WHERE} ${searchScope(scope)}`)
	};
}

/**
 * AI categorization only — every model-decidable Transaction in scope gets the
 * batched unified categorizer. Fire-and-forget from Settings; one scan at a
 * time, never during a sync.
 */
export async function runCategorizationScan(
	db: Database,
	llm: Llm,
	scope: 'all' | 'month' = 'all'
): Promise<void> {
	if (running || isSyncing()) return;
	running = true;
	try {
		const ids = db
			.prepare(`SELECT id FROM transactions WHERE ${CATEGORIZE_WHERE} ${monthWindow(scope)}`)
			.pluck()
			.all() as number[];
		progress(db, 'categorizing', 0, ids.length);
		// chunks match the categorizer's internal batch, so the bar moves per call
		for (let i = 0; i < ids.length; i += 100) {
			await runLlmCategorization(db, llm, ids.slice(i, i + 100)); // fail-soft on LlmUnavailable
			progress(db, 'categorizing', Math.min(i + 100, ids.length), ids.length);
		}
		progress(db, `done — ${ids.length} categorized`, ids.length, ids.length);
	} catch (e) {
		markInterrupted(db); // #81: never leave a mid-scan bar as the 'last scan' record
		throw e;
	} finally {
		running = false;
	}
}

/**
 * Gmail receipt search only — 'all' redoes every posted spend charge from
 * scratch, matched ones included; 'month' only revisits the last month's
 * not-yet-matched charges. Fresh matches get their facts extracted onto the
 * row; the Category is NOT re-judged — that's the categorization scan's job.
 */
export async function runReceiptScan(
	db: Database,
	source: ReceiptSource,
	llm: Llm,
	scope: 'all' | 'month' = 'all'
): Promise<void> {
	if (running || isSyncing()) return;
	// refuse over a dead Gmail connection: an all-inboxes-expired scan would
	// otherwise re-search every matched charge, find nothing, and (before #05's
	// searchOne guard) wipe the receipt corpus. Surface it on the progress bar.
	if (!hasConnectedInbox(db)) {
		progress(db, 'no connected inbox — re-enroll Gmail in Settings');
		return;
	}
	running = true;
	try {
		const charges = db
			.prepare(
				`SELECT id FROM transactions WHERE ${SEARCH_WHERE} ${searchScope(scope)} ORDER BY date DESC`
			)
			.pluck()
			.all() as number[];
		const matched = await lookupLoop(db, source, llm, charges, { recategorize: false });
		progress(
			db,
			`done — ${charges.length} receipt searches, ${matched} matched`,
			charges.length,
			charges.length
		);
	} catch (e) {
		markInterrupted(db);
		throw e;
	} finally {
		running = false;
	}
}

/**
 * The transactions-page bulk button: search Receipts on exactly these charges
 * (age gate ignored), enrich and re-categorize fresh matches. Same
 * one-at-a-time guard and progress channel as the Settings scans.
 */
export async function runLookupBatch(
	db: Database,
	source: ReceiptSource,
	llm: Llm,
	ids: number[]
): Promise<void> {
	if (running || isSyncing()) return;
	if (!hasConnectedInbox(db)) {
		progress(db, 'no connected inbox — re-enroll Gmail in Settings');
		return;
	}
	running = true;
	try {
		const matched = await lookupLoop(db, source, llm, ids);
		progress(db, `done — ${ids.length} receipt searches, ${matched} matched`, ids.length, ids.length);
	} catch (e) {
		markInterrupted(db);
		throw e;
	} finally {
		running = false;
	}
}

async function lookupLoop(
	db: Database,
	source: ReceiptSource,
	llm: Llm,
	charges: number[],
	opts: { recategorize: boolean } = { recategorize: true }
): Promise<number> {
	progress(db, 'searching receipts', 0, charges.length);
	const matched: number[] = [];
	// ponytail: 5 concurrent Gmail searches — ~5x faster, still far under the
	// 250-units/sec quota; sqlite writes are synchronous so interleaving is safe
	const CONCURRENCY = 5;
	for (let i = 0; i < charges.length; i += CONCURRENCY) {
		const chunk = charges.slice(i, i + CONCURRENCY);
		// one bad charge never stops the scan
		const outcomes = await Promise.all(
			chunk.map((id) => triggerLookup(db, source, id).catch(() => null))
		);
		outcomes.forEach((o, j) => o === 'matched' && matched.push(chunk[j]));
		progress(db, 'searching receipts', Math.min(i + CONCURRENCY, charges.length), charges.length);
	}
	// one LLM call per matched receipt, 5 at a time — progress per chunk so the
	// bar keeps moving instead of freezing full for the whole extraction run
	for (let i = 0; i < matched.length; i += CONCURRENCY) {
		progress(db, `extracting ${matched.length} matched receipts`, i, matched.length);
		await Promise.all(
			matched.slice(i, i + CONCURRENCY).map((id) => enrichTransaction(db, llm, id).catch(() => {}))
		);
	}
	progress(db, `extracting ${matched.length} matched receipts`, matched.length, matched.length);
	if (opts.recategorize) await runLlmCategorization(db, llm, matched).catch(() => {});
	return matched.length;
}
