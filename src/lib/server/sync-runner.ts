import { db } from './db';
import { realSource, plaidReady } from './plaid';
import { syncAll, type SyncResult } from './sync';
import { runTransferDetection } from './transfers-db';
import { recordSnapshots, reconstructHistory } from './balances';
import { runRecurringDetection } from './recurring';
import { runDetectors } from './detectors';
import { runResolution } from './resolution';
import { realReceiptSource } from './gmail';
import { realLlm } from './llm';
import { runLlmCategorization } from './llm-categorizer';
import { runMonthlyInsights } from './insights';
import { runWeeklyRecap } from './recap';

// Server-singleton sync state: one sync at a time, launch sync fires once.
let running = false;
let launched = false;

export function isSyncing(): boolean {
	return running;
}

export async function runSync(): Promise<SyncResult[]> {
	if (running || !plaidReady()) return [];
	running = true;
	try {
		const results = await syncAll(db, realSource);
		// Transfer pairing spans Connections (checking→investment), so it runs after all syncs
		runTransferDetection(db);
		// LLM rung (ADR-0006): one batched call over this sync's new arrivals,
		// after pairing so Transfer legs never go; fail-soft — never blocks sync
		const newTxnIds = results.flatMap((r) => r.newTxnIds ?? []);
		await runLlmCategorization(db, realLlm, newTxnIds).catch((e) =>
			console.error('llm categorization failed:', e)
		);
		recordSnapshots(db);
		reconstructHistory(db);
		runRecurringDetection(db); // after transfers: paired legs must not look recurring
		runDetectors(db); // last: Detectors read analytics + recurring output
		// receipt lookup waits for the first enrolled Inbox — before that,
		// "no receipt found" would be a lie; and a Gmail/LLM outage never fails a sync
		if (db.prepare("SELECT 1 FROM inboxes WHERE status = 'connected' LIMIT 1").pluck().get()) {
			await runResolution(db, realReceiptSource, realLlm).catch((e) =>
				console.error('receipt resolution failed:', e)
			);
		}
		// first launch of a new month: prior-month summary + Concern narration;
		// fail-soft inside, but never let narration break a sync either
		await runMonthlyInsights(db, realLlm).catch((e) =>
			console.error('monthly insights failed:', e)
		);
		// first sync of a new week (or changed week data): the Weekly Recap;
		// fail-soft inside, and never lets narration break a sync
		await runWeeklyRecap(db, realLlm).catch((e) => console.error('weekly recap failed:', e));
		return results;
	} finally {
		running = false;
	}
}

/** PLAN.md: no daemon — sync fires as on-launch catch-up when the server boots. */
export function syncOnLaunch(): void {
	if (launched) return;
	launched = true;
	void runSync();
}
