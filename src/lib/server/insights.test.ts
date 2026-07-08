import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import {
	generateInsight,
	getInsight,
	buildNarrationPrompt,
	runMonthlyInsights,
	narrateTopConcerns
} from './insights';
import { upsertConcerns, dismissConcern, activeConcerns } from './concerns';
import { buildDigest } from './digest';
import { LlmUnavailable, type LlmRequest } from './llm';

const TODAY = '2026-07-04';

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
		 VALUES (1, 'ix-1', '2026-06-05', 'WHOLE FOODS', 'WHOLE FOODS', -40000)`
	).run();
	return db;
}

function cannedLlm(reply = 'June was a quiet month; groceries led spending.') {
	const requests: LlmRequest[] = [];
	const llm = async (req: LlmRequest) => {
		requests.push(req);
		return reply;
	};
	return { llm, requests };
}

test('generate stores the Insight; regenerating replaces the row for that period', async () => {
	const db = makeDb();
	const { llm } = cannedLlm();
	const first = await generateInsight(db, llm, 'explain', '2026-06', TODAY);
	expect(first?.narration).toContain('quiet month');

	const again = await generateInsight(db, cannedLlm('Regenerated take.').llm, 'explain', '2026-06', TODAY);
	expect(again?.narration).toBe('Regenerated take.');
	expect(db.prepare('SELECT COUNT(*) FROM insights').pluck().get()).toBe(1); // replaced, not duplicated

	// a different kind for the same period coexists (p3-06 monthly summary)
	await generateInsight(db, llm, 'summary', '2026-06', TODAY);
	expect(db.prepare('SELECT COUNT(*) FROM insights').pluck().get()).toBe(2);
});

test('prompt-construction boundary: the narration prompt contains the digest and nothing else', async () => {
	const db = makeDb();
	const { llm, requests } = cannedLlm();
	await generateInsight(db, llm, 'explain', '2026-06', TODAY);
	expect(requests).toHaveLength(1);
	const prompt = requests[0].prompt;
	expect(prompt).toContain('WHOLE FOODS'); // digest content flows
	expect(prompt).not.toContain('LEAKY-ACCOUNT-NAME'); // fixture leaks don't
	expect(prompt).not.toContain('4242');
	// the digest is embedded verbatim — the instruction text carries no figures
	expect(prompt).toContain(JSON.stringify(buildDigest(db, '2026-06', TODAY), null, 1));
});

test('failure path: LLM unavailable → null, nothing stored, next call retries', async () => {
	const db = makeDb();
	const dead = async () => {
		throw new LlmUnavailable('no key');
	};
	expect(await generateInsight(db, dead, 'explain', '2026-06', TODAY)).toBeNull();
	expect(getInsight(db, 'explain', '2026-06')).toBeNull();
	expect((await generateInsight(db, cannedLlm().llm, 'explain', '2026-06', TODAY))?.narration).toBeTruthy();
});

// --- the automatic half (p3-06) ---

const concern = (over: Partial<Parameters<typeof upsertConcerns>[1][number]> = {}) => ({
	detector: 'spend-spike',
	subject: 'category:1',
	period: '2026-06',
	severity: 80,
	title: 'Dining spiked vs trailing average',
	figures: { spent_dollars: 620, average_dollars: 250 },
	txn_ids: [],
	...over
});

test('first launch in a new month generates the prior-month summary exactly once', async () => {
	const db = makeDb();
	const { llm, requests } = cannedLlm('June, in short.');
	await runMonthlyInsights(db, llm, '2026-07-04');
	expect(getInsight(db, 'summary', '2026-06')?.narration).toBe('June, in short.');
	await runMonthlyInsights(db, llm, '2026-07-04'); // relaunch
	await runMonthlyInsights(db, llm, '2026-07-20'); // later same month
	expect(requests).toHaveLength(1); // no regeneration
});

test('generation failure stores nothing and retries on the next launch', async () => {
	const db = makeDb();
	const dead = async () => {
		throw new LlmUnavailable('outage');
	};
	await runMonthlyInsights(db, dead, '2026-07-04');
	expect(getInsight(db, 'summary', '2026-06')).toBeNull();
	await runMonthlyInsights(db, cannedLlm('Recovered.').llm, '2026-07-05');
	expect(getInsight(db, 'summary', '2026-06')?.narration).toBe('Recovered.');
});

test('top Concerns get one stored line each; dismissed Concerns never narrate', async () => {
	const db = makeDb();
	upsertConcerns(db, [
		concern(),
		concern({ detector: 'new-recurring', subject: 'm:x', severity: 40, title: 'New recurring charge' })
	]);
	const low = activeConcerns(db).find((c) => c.severity === 40)!;
	dismissConcern(db, low.id);
	const { llm, requests } = cannedLlm('One plain line.');
	await narrateTopConcerns(db, llm);
	expect(requests).toHaveLength(1); // only the active one
	const active = activeConcerns(db);
	expect(active).toHaveLength(1);
	expect(active[0].narration).toBe('One plain line.');
});

test('unchanged figures never re-narrate; materially changed figures do', async () => {
	const db = makeDb();
	upsertConcerns(db, [concern()]);
	const { llm, requests } = cannedLlm('Line v1.');
	await narrateTopConcerns(db, llm);
	await narrateTopConcerns(db, llm);
	expect(requests).toHaveLength(1); // hash guard held
	// the Concern re-fires with changed figures
	upsertConcerns(db, [concern({ figures: { spent_dollars: 900, average_dollars: 250 } })]);
	const second = cannedLlm('Line v2.');
	await narrateTopConcerns(db, second.llm);
	expect(second.requests).toHaveLength(1);
	expect(activeConcerns(db)[0].narration).toBe('Line v2.');
});

test('concern narration failure degrades softly and retries next pass', async () => {
	const db = makeDb();
	upsertConcerns(db, [concern()]);
	const dead = async () => {
		throw new LlmUnavailable('outage');
	};
	await narrateTopConcerns(db, dead);
	expect(activeConcerns(db)[0].narration).toBeNull();
	await narrateTopConcerns(db, cannedLlm('Recovered line.').llm);
	expect(activeConcerns(db)[0].narration).toBe('Recovered line.');
});

test('narration prompt tells the model to hedge on data-quality counts and stick to assumptions', () => {
	const prompt = buildNarrationPrompt(buildDigest(makeDb(), '2026-06', TODAY));
	expect(prompt).toContain('data_quality');
	expect(prompt).toContain('assumptions');
	expect(prompt).toContain('never invent');
});
