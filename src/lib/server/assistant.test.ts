import { test, expect } from 'vitest';
import Database, { type Database as Db } from 'better-sqlite3';
import { migrate } from './db/migrate';
import {
	ASSISTANT_TOOLS,
	MAX_TOOL_CALLS_PER_ITERATION,
	MAX_TOOL_ITERATIONS,
	TOOL_RESULT_MAX_CHARS,
	TXN_LIST_CAP,
	buildAssistantSystemPrompt,
	executeTool,
	householdContextBlock,
	runAssistantTurn,
	sanitizeFilters
} from './assistant';
import { getMessages, listConversations } from './conversations';
import { LlmUnavailable, type LlmChatReply, type LlmChatRequest, type LlmChat } from './llm';

const TODAY = '2026-07-04';

// Sentinels that must NEVER reach the model: account name, mask, balance.
const LEAKS = ['LEAKY-ACCOUNT-NAME', '9876', '77777777'];

function makeDb() {
	const db = new Database(':memory:');
	migrate(db);
	db.prepare("INSERT INTO connections (institution_name, plaid_item_id) VALUES ('B', 'i')").run();
	db.prepare(
		`INSERT INTO accounts (connection_id, plaid_account_id, name, type, subtype, mask, current_balance_cents)
		 VALUES (1, 'a1', 'LEAKY-ACCOUNT-NAME', 'depository', 'checking', '9876', 77777777)`
	).run();
	return db;
}

let seq = 0;
function txn(db: Db, date: string, cents: number, merchant = 'SHOP') {
	db.prepare(
		`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, merchant, amount_cents)
		 VALUES (1, ?, ?, ?, ?, ?)`
	).run(`t-${++seq}`, date, merchant, merchant, cents);
}

/** Canned tool-call sequences; repeats the last reply if called again. */
function scriptedLlm(script: LlmChatReply[]) {
	const requests: LlmChatRequest[] = [];
	let i = 0;
	const llm: LlmChat = async (req) => {
		requests.push(req);
		return script[Math.min(i++, script.length - 1)];
	};
	return { llm, requests };
}

const call = (name: string, input: unknown, id = `c${++seq}`) => ({ id, name, input });
const answer = (text: string): LlmChatReply => ({ text, toolCalls: [] });

// ---------- tools against the real engines ----------

test('run_report returns the Reports engine aggregates, dollar-denominated', () => {
	const db = makeDb();
	txn(db, '2026-06-10', -25000, 'CAFE');
	txn(db, '2026-06-12', -75000, 'DENTIST');
	txn(db, '2026-06-13', 90000, 'EMPLOYER'); // income — not in the spending tab
	const r = executeTool(
		db,
		'run_report',
		{ filters: { date: { from: '2026-06-01', to: '2026-06-30' } }, tab: 'spending', group_by: 'merchant' },
		TODAY
	) as { months: { total_dollars: number }[]; breakdown: { label: string; amount_dollars: number }[]; stats: { total_dollars: number; txn_count: number } };
	expect(r.stats).toMatchObject({ total_dollars: 1000, txn_count: 2 });
	expect(r.breakdown.map((b) => [b.label, b.amount_dollars])).toEqual([
		['DENTIST', 750],
		['CAFE', 250]
	]);
	expect(r.months).toEqual([{ month: '2026-06', total_dollars: 1000 }]);
});

test('list_transactions respects the count cap and ships no account fields', () => {
	const db = makeDb();
	for (let i = 1; i <= TXN_LIST_CAP + 5; i++) txn(db, '2026-06-15', -100 * i);
	const r = executeTool(db, 'list_transactions', { limit: 9999 }, TODAY) as {
		transactions: Record<string, unknown>[];
		truncated: boolean;
	};
	expect(r.transactions).toHaveLength(TXN_LIST_CAP);
	expect(r.truncated).toBe(true);
	const json = JSON.stringify(r);
	for (const leak of LEAKS) expect(json).not.toContain(leak);
	expect(Object.keys(r.transactions[0]).sort()).toEqual(
		['amount_dollars', 'category', 'date', 'description', 'tags'].sort()
	);
});

test('budget_month and get_digest validate input and delegate to the engines', () => {
	const db = makeDb();
	expect(executeTool(db, 'budget_month', { month: 'nope' }, TODAY)).toEqual({
		error: 'month must be "YYYY-MM"'
	});
	expect(executeTool(db, 'budget_month', { month: '2026-06' }, TODAY)).toMatchObject({
		month: '2026-06'
	});
	expect(executeTool(db, 'get_digest', { period: '2026-06' }, TODAY)).toMatchObject({
		period: '2026-06'
	});
	expect(executeTool(db, 'nonsense', {}, TODAY)).toEqual({ error: 'unknown tool: nonsense' });
});

test('sanitizeFilters: garbage-tolerant, no account dimension survives', () => {
	expect(sanitizeFilters(undefined)).toEqual({ date: { preset: 'all' } });
	expect(
		sanitizeFilters({
			categories: { include: [3, 'x', -1] },
			accounts: { include: [1] }, // the model has no account vocabulary — dropped
			merchants: { include: ['CAFE'] },
			date: { preset: 'ytd' }
		})
	).toEqual({
		categories: { include: [3] },
		merchants: { include: ['CAFE'] },
		date: { preset: 'ytd' }
	});
	expect(sanitizeFilters({ date: { from: '2026-02-01', to: '2026-01-01' } }).date).toEqual({
		from: '2026-01-01',
		to: '2026-02-01'
	});
});

// ---------- the tool loop ----------

test('one turn: tools execute, audit is recorded per call, messages persist in order', async () => {
	const db = makeDb();
	txn(db, '2026-06-10', -25000, 'CAFE');
	const { llm, requests } = scriptedLlm([
		{ text: '', toolCalls: [call('run_report', { tab: 'spending', group_by: 'merchant' })] },
		answer('You spent $250 at CAFE in total.')
	]);
	const result = await runAssistantTurn(db, llm, null, 'how much at cafes?', TODAY);
	if (!result.ok) throw new Error('expected ok');

	// conversation created with the truncated first question as title
	expect(listConversations(db)[0].title).toBe('how much at cafes?');
	const msgs = getMessages(db, result.conversationId);
	expect(msgs.map((m) => [m.role, m.content])).toEqual([
		['user', 'how much at cafes?'],
		['assistant', 'You spent $250 at CAFE in total.']
	]);

	// the audit is the egress receipt: exact tool payload, recorded with the reply
	const audit = JSON.parse(msgs[1].tool_audit!) as { tool: string; result: { stats: { total_dollars: number } } }[];
	expect(audit).toHaveLength(1);
	expect(audit[0].tool).toBe('run_report');
	expect(audit[0].result.stats.total_dollars).toBe(250);

	// the second LLM call saw the tool result
	expect(requests).toHaveLength(2);
	const toolTurn = requests[1].messages.at(-1)!;
	expect(toolTurn.role).toBe('tool');
	expect(JSON.stringify(toolTurn)).toContain('CAFE');
	expect(requests[0].tools).toBe(ASSISTANT_TOOLS);
});

test('the iteration cap halts a runaway script and forces an answer', async () => {
	const db = makeDb();
	const { llm, requests } = scriptedLlm([
		{ text: 'digging…', toolCalls: [call('budget_month', { month: '2026-06' })] } // forever
	]);
	const result = await runAssistantTurn(db, llm, null, 'loop forever', TODAY);
	if (!result.ok) throw new Error('expected ok');
	expect(requests).toHaveLength(MAX_TOOL_ITERATIONS + 1); // cap, then the forced final call
	expect(requests.at(-1)!.tools).toEqual([]); // no more tools on the final call
	expect(JSON.stringify(requests.at(-1)!.messages.at(-1))).toContain('Tool budget exhausted');
	expect(result.message.content).toBe('digging…'); // answered with what it had
	expect(JSON.parse(result.message.tool_audit!)).toHaveLength(MAX_TOOL_ITERATIONS);
});

test('follow-ups replay the thread; a second turn appends to the same conversation', async () => {
	const db = makeDb();
	const first = await runAssistantTurn(db, scriptedLlm([answer('Answer one.')]).llm, null, 'q1', TODAY);
	if (!first.ok) throw new Error('expected ok');
	const { llm, requests } = scriptedLlm([answer('Answer two.')]);
	await runAssistantTurn(db, llm, first.conversationId, 'and q2?', TODAY);
	expect(getMessages(db, first.conversationId).map((m) => m.content)).toEqual([
		'q1',
		'Answer one.',
		'and q2?',
		'Answer two.'
	]);
	// the model saw the full thread
	expect(requests[0].messages.map((m) => ('content' in m ? m.content : ''))).toEqual([
		'q1',
		'Answer one.',
		'and q2?'
	]);
});

test('LLM failure mid-turn keeps the owner message and surfaces a soft error', async () => {
	const db = makeDb();
	const dead: LlmChat = async () => {
		throw new LlmUnavailable('network blip');
	};
	const result = await runAssistantTurn(db, dead, null, 'my question', TODAY);
	expect(result).toMatchObject({ ok: false, error: 'unavailable' });
	const msgs = getMessages(db, result.conversationId);
	expect(msgs.map((m) => m.role)).toEqual(['user']); // kept, no half-written assistant row
});

// ---------- personalization ----------

test('household context appears in the system prompt only when set, verbatim', async () => {
	const db = makeDb();
	const bare = scriptedLlm([answer('hi')]);
	await runAssistantTurn(db, bare.llm, null, 'q', TODAY);
	expect(bare.requests[0].system).not.toContain('Household context');
	expect(householdContextBlock(db)).toBeNull();

	db.prepare("INSERT INTO settings (key, value) VALUES ('household_dependents', '2')").run();
	db.prepare("INSERT INTO settings (key, value) VALUES ('household_filing_status', 'married filing jointly')").run();
	const block = householdContextBlock(db)!;
	expect(block).toContain('- Dependents: 2');
	expect(block).toContain('- Filing status: married filing jointly');
	expect(block).not.toContain('Household income'); // unset fields never go

	const set = scriptedLlm([answer('hi')]);
	await runAssistantTurn(db, set.llm, null, 'q', TODAY);
	expect(set.requests[0].system).toContain(block); // Settings shows exactly this block
});

test('the system prompt carries the glossary, today, and the taxonomy', () => {
	const prompt = buildAssistantSystemPrompt(makeDb(), TODAY);
	for (const term of ['Flex mode', 'rollover', 'Left to budget', TODAY, "I don't have that data"])
		expect(prompt).toContain(term);
});

// ---------- egress discipline ----------

test('no assistant payload — system prompt or any tool result — can leak account data', async () => {
	const db = makeDb();
	txn(db, '2026-06-10', -25000, 'CAFE');
	const { llm, requests } = scriptedLlm([
		{
			text: '',
			toolCalls: [
				call('run_report', { tab: 'spending', group_by: 'merchant' }),
				call('list_transactions', {}),
				call('budget_month', { month: '2026-06' }),
				call('get_digest', { period: '2026-06' })
			]
		},
		answer('done')
	]);
	await runAssistantTurn(db, llm, null, 'audit me', TODAY);
	// everything that crossed the seam, this turn: systems, history, tool results
	const everySentByte = JSON.stringify(requests);
	for (const leak of LEAKS) expect(everySentByte).not.toContain(leak);
	expect(everySentByte).toContain('CAFE'); // the allowed shapes still flow
});

// ---------- boundedness & durability (#14) ----------

test('an empty final reply persists as "(no reply)", never an empty message', async () => {
	const db = makeDb();
	const { llm } = scriptedLlm([answer('   ')]);
	const result = await runAssistantTurn(db, llm, null, 'q', TODAY);
	expect(result.ok).toBe(true);
	const msgs = getMessages(db, result.conversationId);
	expect(msgs[1]).toMatchObject({ role: 'assistant', content: '(no reply)' });
});

test('tool fan-out is capped per iteration; excess calls get an error result', async () => {
	const db = makeDb();
	txn(db, '2026-06-10', -25000, 'CAFE');
	const calls = Array.from({ length: MAX_TOOL_CALLS_PER_ITERATION + 2 }, () =>
		call('budget_month', { month: '2026-06' })
	);
	const { llm, requests } = scriptedLlm([{ text: '', toolCalls: calls }, answer('done')]);
	const result = await runAssistantTurn(db, llm, null, 'q', TODAY);
	expect(result.ok).toBe(true);
	// every tool_use id still got a result back (API contract)
	const toolTurn = requests[1].messages.at(-1);
	if (toolTurn?.role !== 'tool') throw new Error('expected tool turn');
	expect(toolTurn.results).toHaveLength(calls.length);
	const errors = toolTurn.results.filter((r) => r.content.includes('too many tool calls'));
	expect(errors).toHaveLength(2);
});

test('oversized tool results are truncated with a marker before crossing the seam', async () => {
	const db = makeDb();
	const huge = 'X'.repeat(700);
	for (let i = 0; i < TXN_LIST_CAP; i++) txn(db, '2026-06-15', -100, `${huge}-${i}`);
	const { llm, requests } = scriptedLlm([
		{ text: '', toolCalls: [call('list_transactions', {})] },
		answer('done')
	]);
	await runAssistantTurn(db, llm, null, 'q', TODAY);
	const toolTurn = requests[1].messages.at(-1);
	if (toolTurn?.role !== 'tool') throw new Error('expected tool turn');
	expect(toolTurn.results[0].content.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS + 40);
	expect(toolTurn.results[0].content).toContain('…[truncated: result too large]');
});
