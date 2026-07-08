import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import {
	buildRecapPrompt,
	generateRecap,
	lastCompletedWeekStart,
	listRecaps,
	runWeeklyRecap
} from './recap';
import { buildWeeklyDigest } from './weekly-digest';
import { getInsight } from './insights';
import { LlmUnavailable, type LlmRequest } from './llm';

const TODAY = '2026-07-04'; // Saturday → last completed week starts Mon 2026-06-22
const WEEK = '2026-06-22';

function makeDb() {
	const db = new Database(':memory:');
	migrate(db);
	db.prepare("INSERT INTO connections (institution_name, plaid_item_id) VALUES ('B', 'i')").run();
	db.prepare(
		`INSERT INTO accounts (connection_id, plaid_account_id, name, type, subtype, mask)
		 VALUES (1, 'a1', 'LEAKY-ACCOUNT-NAME', 'depository', 'checking', '4242')`
	).run();
	db.prepare(
		`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, merchant, amount_cents)
		 VALUES (1, 'w-1', '2026-06-23', 'WHOLE FOODS', 'WHOLE FOODS', -40000)`
	).run();
	return db;
}

function cannedLlm(reply = 'A quieter week; groceries led.') {
	const requests: LlmRequest[] = [];
	const llm = async (req: LlmRequest) => {
		requests.push(req);
		return reply;
	};
	return { llm, requests };
}

test('lastCompletedWeekStart is the prior Monday, across month and year lines', () => {
	expect(lastCompletedWeekStart('2026-07-04')).toBe('2026-06-22');
	expect(lastCompletedWeekStart('2026-06-29')).toBe('2026-06-22'); // Monday: last week just ended
	expect(lastCompletedWeekStart('2026-01-01')).toBe('2025-12-22');
});

test('sync hook generates the just-completed week and stores a recap row', async () => {
	const db = makeDb();
	const { llm } = cannedLlm('Week in short.');
	await runWeeklyRecap(db, llm, TODAY);
	expect(getInsight(db, 'recap', WEEK)?.narration).toBe('Week in short.');
});

test('idempotent while the digest is unchanged; regenerates when data changed', async () => {
	const db = makeDb();
	const { llm, requests } = cannedLlm();
	await runWeeklyRecap(db, llm, TODAY);
	await runWeeklyRecap(db, llm, TODAY); // re-sync, nothing changed
	expect(requests).toHaveLength(1);

	// a late-posting transaction lands inside the recapped week
	db.prepare(
		`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, merchant, amount_cents)
		 VALUES (1, 'w-2', '2026-06-27', 'LATE CHARGE', 'LATE CHARGE', -12300)`
	).run();
	const second = cannedLlm('Revised week.');
	await runWeeklyRecap(db, second.llm, TODAY);
	expect(second.requests).toHaveLength(1);
	expect(getInsight(db, 'recap', WEEK)?.narration).toBe('Revised week.');
	expect(db.prepare("SELECT COUNT(*) FROM insights WHERE kind = 'recap'").pluck().get()).toBe(1); // replaced
});

test('fails soft: no key stores nothing, a later sync retries', async () => {
	const db = makeDb();
	const dead = async () => {
		throw new LlmUnavailable('no key');
	};
	await expect(runWeeklyRecap(db, dead, TODAY)).resolves.toBeUndefined(); // never throws into sync
	expect(getInsight(db, 'recap', WEEK)).toBeNull();
	await runWeeklyRecap(db, cannedLlm('Recovered.').llm, TODAY);
	expect(getInsight(db, 'recap', WEEK)?.narration).toBe('Recovered.');
});

test('history is retained: new weeks add rows, old recaps stay listable', async () => {
	const db = makeDb();
	await generateRecap(db, cannedLlm('June week 4.').llm, '2026-06-22');
	await generateRecap(db, cannedLlm('June week 5.').llm, '2026-06-29');
	const recaps = listRecaps(db);
	expect(recaps.map((r) => r.period)).toEqual(['2026-06-29', '2026-06-22']); // newest first
	expect(recaps[1].narration).toBe('June week 4.');
});

test('prompt boundary: the weekly digest and nothing else reaches the model', async () => {
	const db = makeDb();
	const { llm, requests } = cannedLlm();
	await runWeeklyRecap(db, llm, TODAY);
	const prompt = requests[0].prompt;
	expect(prompt).toContain('WHOLE FOODS'); // digest content flows
	expect(prompt).not.toContain('LEAKY-ACCOUNT-NAME'); // fixture leaks don't
	expect(prompt).not.toContain('4242');
	expect(prompt).toContain(JSON.stringify(buildWeeklyDigest(db, WEEK), null, 1));
	expect(buildRecapPrompt(buildWeeklyDigest(db, WEEK))).toContain('never invent');
});
