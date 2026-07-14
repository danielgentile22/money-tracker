import type { Database } from 'better-sqlite3';
import { db } from './db';
import { realSource, plaidReady } from './plaid';
import { syncAll, type PlaidSource, type SyncResult } from './sync';
import { runTransferDetection } from './transfers-db';
import { recordSnapshots, reconstructHistory, localToday } from './balances';
import { runRecurringDetection } from './recurring';
import { runDetectors } from './detectors';
import { runResolution } from './resolution';
import { realReceiptSource, type ReceiptSource } from './gmail';
import { realLlm, type Llm } from './llm';
import { runLlmCategorization } from './llm-categorizer';
import { runMonthlyInsights } from './insights';
import { runWeeklyRecap } from './recap';
import { isBackfilling } from './backfill';

// Server-singleton sync state: one sync at a time, launch sync fires once.
let running = false;
let launched = false;

export function isSyncing(): boolean {
	return running;
}

/**
 * One pipeline step, fail-soft: a bug in post-sync analytics degrades one
 * feature, it never aborts the rest of the pipeline, crashes the boot catch-up,
 * or turns a committed sync into a 500 (p9-33). Mirrors the .catch the LLM/
 * receipt steps already used, extended to the deterministic detectors too.
 */
async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
	try {
		await fn();
	} catch (e) {
		console.error(`${label} failed:`, e);
	}
}

/**
 * The whole money pipeline, dependency-injected so it runs against fakes in
 * tests (p9-34). runSync wraps this with the single-flight guard and the real
 * singletons. Ordering is load-bearing — see the per-step comments.
 */
export async function runSyncPipeline(
	database: Database,
	source: PlaidSource,
	receiptSource: ReceiptSource,
	llm: Llm
): Promise<SyncResult[]> {
	const results = await syncAll(database, source);
	// Transfer pairing spans Connections (checking→investment), so it runs after all syncs
	await step('transfer detection', () => runTransferDetection(database));
	// LLM rung (ADR-0006): one batched call over this sync's new arrivals, after
	// pairing so Transfer legs never go; fail-soft — never blocks sync
	const newTxnIds = results.flatMap((r) => r.newTxnIds ?? []);
	await step('llm categorization', () => runLlmCategorization(database, llm, newTxnIds));
	// snapshots only for the connections that actually synced this run: a broken
	// connection keeps its stale balances, which we must not stamp as fresh
	// 'real' net-worth points (p9-09).
	const syncedIds = results.filter((r) => r.ok).map((r) => r.connectionId);
	await step('snapshots', () => recordSnapshots(database, localToday(), syncedIds));
	await step('history reconstruction', () => reconstructHistory(database));
	// after transfers: paired legs must not look recurring
	await step('recurring detection', () => runRecurringDetection(database));
	// last: Detectors read analytics + recurring output
	await step('detectors', () => runDetectors(database));
	// receipt lookup waits for the first enrolled Inbox — before that,
	// "no receipt found" would be a lie; and a Gmail/LLM outage never fails a sync
	if (database.prepare("SELECT 1 FROM inboxes WHERE status = 'connected' LIMIT 1").pluck().get()) {
		await step('receipt resolution', () => runResolution(database, receiptSource, llm));
	}
	// first launch of a new month: prior-month summary + Concern narration
	await step('monthly insights', () => runMonthlyInsights(database, llm));
	// first sync of a new week (or changed week data): the Weekly Recap
	await step('weekly recap', () => runWeeklyRecap(database, llm));
	return results;
}

export async function runSync(): Promise<SyncResult[]> {
	// symmetric to backfill's `if (running || isSyncing())` guard: never overlap a
	// Settings scan (p9-32). isSyncing/isBackfilling form a call-time-only import
	// cycle, which is safe (both are read inside functions, never at module load).
	if (running || isBackfilling() || !plaidReady()) return [];
	running = true;
	try {
		return await runSyncPipeline(db, realSource, realReceiptSource, realLlm);
	} finally {
		running = false;
	}
}

/** PLAN.md: no daemon — sync fires as on-launch catch-up when the server boots. */
export function syncOnLaunch(): void {
	if (launched) return;
	launched = true;
	// p9-33: catch so a pipeline throw at boot logs instead of becoming an
	// unhandled rejection that terminates the freshly booted server.
	void runSync().catch((e) => console.error('launch sync failed:', e));
}
