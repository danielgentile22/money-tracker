import type { Database } from 'better-sqlite3';
import { localToday } from './balances';
import { reportData, type GroupBy, type ReportTab } from './reports';
import { queryLedger } from './ledger';
import { budgetMonth } from './budgets';
import { buildDigest } from './digest';
import { DATE_PRESETS, type DatePreset, type FilterSet } from './filters';
import {
	LlmUnavailable,
	modelSetting,
	type ChatTurn,
	type LlmChat,
	type ToolDef
} from './llm';
import { appendMessage, createConversation, getMessages, type Message } from './conversations';

// Session 5 Pass B: the Assistant engine — ONE module owns the whole exchange.
// Given a conversation and a new owner message it assembles the system prompt,
// runs the bounded tool loop against the real engines, audits every payload,
// persists both messages, and returns the reply. The panel only renders.
//
// Egress contract (ADR-0001 channel #3): tool payloads carry transaction
// descriptions, dates, amounts, and aggregates — the same shapes the owner's
// own pages render. No tool can return account identifiers, account balances,
// credentials, or email content; there is no account dimension at all.

/** One question can never turn into an unbounded number of API calls. */
export const MAX_TOOL_ITERATIONS = 6;
/** A broad question can't ship the entire ledger in one payload. */
export const TXN_LIST_CAP = 40;
/** One iteration can't fan out into unbounded tool executions (#14 / ADR-0011). */
export const MAX_TOOL_CALLS_PER_ITERATION = 4;
/** One tool payload can't blow up the context window; truncated with a marker. */
export const TOOL_RESULT_MAX_CHARS = 20_000;

const dollars = (cents: number) => Math.round(cents) / 100;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

// ---------- tool definitions ----------

const ID_FILTER = {
	type: 'object',
	properties: {
		include: { type: 'array', items: { type: 'integer' } },
		exclude: { type: 'array', items: { type: 'integer' } }
	}
};

const FILTERS_SCHEMA = {
	type: 'object',
	description:
		'Transaction filter. Dimensions combine with AND. Ids come from the taxonomy in the system prompt. ' +
		`date is either {"preset": one of ${JSON.stringify(DATE_PRESETS)}} or {"from":"YYYY-MM-DD","to":"YYYY-MM-DD"} (inclusive).`,
	properties: {
		categories: ID_FILTER,
		groups: ID_FILTER,
		tags: ID_FILTER,
		merchants: {
			type: 'object',
			properties: {
				include: { type: 'array', items: { type: 'string' } },
				exclude: { type: 'array', items: { type: 'string' } }
			}
		},
		date: { type: 'object' }
	}
};

export const ASSISTANT_TOOLS: ToolDef[] = [
	{
		name: 'run_report',
		description:
			'Aggregate spending or income over any date range: monthly totals, a breakdown by group/category/merchant/tag, and overall stats. The same math the Reports page renders.',
		input_schema: {
			type: 'object',
			properties: {
				filters: FILTERS_SCHEMA,
				tab: { type: 'string', enum: ['spending', 'income'] },
				group_by: { type: 'string', enum: ['group', 'category', 'merchant', 'tag'] }
			},
			required: ['tab', 'group_by']
		}
	},
	{
		name: 'list_transactions',
		description: `Individual transactions matching a filter, newest first, capped at ${TXN_LIST_CAP}. Use run_report for totals — this is for inspecting specific charges.`,
		input_schema: {
			type: 'object',
			properties: {
				filters: FILTERS_SCHEMA,
				limit: { type: 'integer', description: `max rows, up to ${TXN_LIST_CAP}` }
			}
		}
	},
	{
		name: 'budget_month',
		description:
			'The budget snapshot for one month ("YYYY-MM"): income vs expected, per-group budget lines with actuals, flex pool, rollovers, left to budget. The same snapshot the Budgets page renders.',
		input_schema: {
			type: 'object',
			properties: { month: { type: 'string', description: 'YYYY-MM' } },
			required: ['month']
		}
	},
	{
		name: 'get_digest',
		description:
			'The monthly digest for a period ("YYYY-MM"): summary figures, month-over-month movement, top categories and merchants, concerns, projections, data-quality counts.',
		input_schema: {
			type: 'object',
			properties: { period: { type: 'string', description: 'YYYY-MM' } },
			required: ['period']
		}
	}
];

// ---------- tool input sanitizing ----------

function idList(v: unknown): number[] | undefined {
	if (!Array.isArray(v)) return undefined;
	const out = v.map(Number).filter((n) => Number.isInteger(n) && n > 0);
	return out.length ? out : undefined;
}

function nameList(v: unknown): string[] | undefined {
	if (!Array.isArray(v)) return undefined;
	const out = v.filter((s): s is string => typeof s === 'string' && s.trim() !== '');
	return out.length ? out : undefined;
}

/**
 * Raw tool input → FilterSet. Garbage-tolerant like parseFilters; the account
 * dimension is deliberately unreachable — the model has no account vocabulary.
 */
export function sanitizeFilters(raw: unknown): FilterSet {
	const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const f: FilterSet = { date: { preset: 'all' } };
	for (const dim of ['categories', 'groups', 'tags'] as const) {
		const d = r[dim] as Record<string, unknown> | undefined;
		const include = idList(d?.include);
		const exclude = idList(d?.exclude);
		if (include || exclude) f[dim] = { ...(include && { include }), ...(exclude && { exclude }) };
	}
	const m = r.merchants as Record<string, unknown> | undefined;
	const include = nameList(m?.include);
	const exclude = nameList(m?.exclude);
	if (include || exclude) f.merchants = { ...(include && { include }), ...(exclude && { exclude }) };

	const d = r.date as Record<string, unknown> | undefined;
	if (d) {
		if (typeof d.preset === 'string' && DATE_PRESETS.includes(d.preset as DatePreset))
			f.date = { preset: d.preset as DatePreset };
		else if (
			typeof d.from === 'string' &&
			typeof d.to === 'string' &&
			ISO_DATE.test(d.from) &&
			ISO_DATE.test(d.to)
		)
			f.date = d.from <= d.to ? { from: d.from, to: d.to } : { from: d.to, to: d.from };
	}
	return f;
}

// ---------- tool execution ----------

/**
 * Execute one tool against the real engines. Returns the exact payload the
 * model sees (JSON-serializable); bad input returns {error} so the model can
 * recover instead of the loop dying.
 */
export function executeTool(db: Database, name: string, input: unknown, today: string): unknown {
	const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
	try {
		switch (name) {
			case 'run_report': {
				const tab: ReportTab = args.tab === 'income' ? 'income' : 'spending';
				const groupBy = (['group', 'category', 'merchant', 'tag'] as const).includes(
					args.group_by as GroupBy
				)
					? (args.group_by as GroupBy)
					: 'category';
				// pageSize 0: aggregates only — the ledger drill-down is list_transactions' job
				const r = reportData(db, sanitizeFilters(args.filters), tab, groupBy, {
					today,
					pageSize: 0
				});
				return {
					months: r.months.map((m) => ({ month: m.month, total_dollars: dollars(m.total_cents) })),
					breakdown: r.breakdown.map((b) => ({
						label: b.label,
						amount_dollars: dollars(b.amount_cents),
						share_pct: Math.round(b.share * 1000) / 10
					})),
					stats: {
						total_dollars: dollars(r.stats.total_cents),
						monthly_avg_dollars: dollars(r.stats.monthly_avg_cents),
						txn_count: r.stats.txn_count
					}
				};
			}
			case 'list_transactions': {
				const limit = Math.min(
					Math.max(1, Math.trunc(Number(args.limit)) || TXN_LIST_CAP),
					TXN_LIST_CAP
				);
				const rows = queryLedger(db, sanitizeFilters(args.filters), { today, limit: limit + 1 });
				const page = rows.slice(0, limit);
				const tagRows = page.length
					? (db
							.prepare(
								`SELECT tt.transaction_id, tg.name FROM transaction_tags tt
								 JOIN tags tg ON tg.id = tt.tag_id
								 WHERE tt.transaction_id IN (${page.map(() => '?').join(',')})`
							)
							.all(...page.map((r) => r.id)) as { transaction_id: number; name: string }[])
					: [];
				const tagsFor = new Map<number, string[]>();
				for (const t of tagRows) (tagsFor.get(t.transaction_id) ?? tagsFor.set(t.transaction_id, []).get(t.transaction_id)!).push(t.name);
				return {
					// explicitly no account fields — descriptions, dates, amounts, taxonomy only
					transactions: page.map((r) => ({
						date: r.date,
						description: r.merchant ?? r.name,
						amount_dollars: dollars(r.amount_cents),
						category: r.category_name,
						tags: tagsFor.get(r.id) ?? []
					})),
					truncated: rows.length > limit
				};
			}
			case 'budget_month': {
				if (typeof args.month !== 'string' || !MONTH.test(args.month))
					return { error: 'month must be "YYYY-MM"' };
				return budgetMonth(db, args.month);
			}
			case 'get_digest': {
				if (typeof args.period !== 'string' || !MONTH.test(args.period))
					return { error: 'period must be "YYYY-MM"' };
				return buildDigest(db, args.period, today);
			}
			default:
				return { error: `unknown tool: ${name}` };
		}
	} catch (e) {
		return { error: e instanceof Error ? e.message : String(e) };
	}
}

// ---------- system prompt ----------

/**
 * The owner's household context, rendered EXACTLY as sent — Settings shows
 * this same block. Null when no field is set (nothing personal goes by default).
 */
export function householdContextBlock(db: Database): string | null {
	const get = (key: string) =>
		(db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as string | undefined)?.trim() ||
		null;
	const fields: [string, string | null][] = [
		['Dependents', get('household_dependents')],
		['Household income', get('household_income')],
		['Filing status', get('household_filing_status')]
	];
	const set = fields.filter(([, v]) => v !== null);
	if (!set.length) return null;
	return ['Household context (provided by the owner):', ...set.map(([k, v]) => `- ${k}: ${v}`)].join(
		'\n'
	);
}

export function buildAssistantSystemPrompt(db: Database, today: string): string {
	const cats = db
		.prepare(
			`SELECT c.id, c.name, g.name AS grp
			 FROM categories c JOIN category_groups g ON g.id = c.group_id
			 WHERE c.disabled = 0 ORDER BY g.sort_order, g.id, c.sort_order, c.id`
		)
		.all() as { id: number; name: string; grp: string }[];
	const groups = new Map<string, { id: number; name: string }[]>();
	for (const c of cats) (groups.get(c.grp) ?? groups.set(c.grp, []).get(c.grp)!).push({ id: c.id, name: c.name });
	const tags = db.prepare('SELECT id, name FROM tags ORDER BY name').all() as {
		id: number;
		name: string;
	}[];
	const household = householdContextBlock(db);

	return [
		"You are the assistant inside the owner's local money-tracking app. You answer",
		'questions about their finances by calling the read-only tools, and questions about',
		'how the app itself works from the glossary below.',
		'',
		'Privacy contract: you receive transaction descriptions, dates, amounts, and',
		'aggregates — never account numbers, account balances, credentials, or email',
		'content. Never ask the owner for any of those.',
		'',
		'Honesty: every figure you state must come from a tool result. If the data cannot',
		"answer the question, say \"I don't have that data\" — never invent, estimate, or",
		'extrapolate a number.',
		'',
		'App glossary: Categories are organized into Groups. Tags are cross-cutting labels;',
		'a transaction may carry several. Budgets are per-month with fill-forward: a',
		"month's effective budget is the most recent one set at or before it. Flex mode",
		'splits categories into fixed (own budget) and flexible (share one Flex pool);',
		'category mode budgets every category separately. A rollover carries a',
		"category's unspent budget (or overspend) into the next month, starting from its",
		'anchor month. "Left to budget" is expected income minus allocations — positive',
		'slack is the savings plan. Transfers and investment activity never count as',
		'income or expenses.',
		'',
		`Today's date: ${today}.`,
		'',
		'The owner\'s taxonomy (use these ids in filters):',
		JSON.stringify(
			{
				groups: [...groups.entries()].map(([name, categories]) => ({ name, categories })),
				tags
			},
			null,
			1
		),
		...(household ? ['', household] : [])
	].join('\n');
}

// ---------- the turn ----------

export type AuditEntry = { tool: string; input: unknown; result: unknown };
export type TurnResult =
	| { ok: true; conversationId: number; message: Message }
	| { ok: false; conversationId: number; error: 'unavailable' };

/**
 * One owner message → one assistant reply. The owner message persists even
 * when the LLM fails (soft error; the panel offers retry); the assistant
 * message lands with its full tool audit attached.
 */
export async function runAssistantTurn(
	db: Database,
	llm: LlmChat,
	conversationId: number | null,
	userText: string,
	today: string = localToday()
): Promise<TurnResult> {
	const model = modelSetting(db, 'assistant_model');
	const system = buildAssistantSystemPrompt(db, today);
	const convoId = conversationId ?? createConversation(db, userText).id;
	appendMessage(db, convoId, 'user', userText);

	// prior turns replay as plain text — tool traffic is not resent (the audit
	// stays local; the model re-queries if it needs figures again)
	const turns: ChatTurn[] = getMessages(db, convoId).map((m) =>
		m.role === 'user' ? { role: 'user', content: m.content } : { role: 'assistant', content: m.content }
	);

	const audit: AuditEntry[] = [];
	let finalText: string | null = null;
	try {
		for (let i = 0; i < MAX_TOOL_ITERATIONS && finalText === null; i++) {
			const reply = await llm({ model, system, messages: turns, tools: ASSISTANT_TOOLS, maxTokens: 1500 });
			if (!reply.toolCalls.length) {
				finalText = reply.text;
				break;
			}
			turns.push({ role: 'assistant', content: reply.text, toolCalls: reply.toolCalls });
			turns.push({
				role: 'tool',
				results: reply.toolCalls.map((tc, idx) => {
					// every tool_use id must get a result, but only the first N execute
					const result =
						idx < MAX_TOOL_CALLS_PER_ITERATION
							? executeTool(db, tc.name, tc.input, today)
							: { error: `too many tool calls; at most ${MAX_TOOL_CALLS_PER_ITERATION} per turn` };
					audit.push({ tool: tc.name, input: tc.input, result });
					let content = JSON.stringify(result);
					if (content.length > TOOL_RESULT_MAX_CHARS)
						content = content.slice(0, TOOL_RESULT_MAX_CHARS) + '…[truncated: result too large]';
					return { toolCallId: tc.id, content };
				})
			});
		}
		if (finalText === null) {
			// cap hit: the model is told to answer with what it has — no more tools
			turns.push({
				role: 'user',
				content: 'Tool budget exhausted. Answer now using only what you already have.'
			});
			finalText = (await llm({ model, system, messages: turns, tools: [], maxTokens: 1500 })).text;
		}
	} catch (e) {
		if (e instanceof LlmUnavailable) return { ok: false, conversationId: convoId, error: 'unavailable' };
		throw e;
	}

	// #22: never persist an empty assistant message — an empty turn breaks the
	// conversation permanently on replay (the API rejects empty content)
	if (!finalText.trim()) finalText = '(no reply)';
	const message = appendMessage(db, convoId, 'assistant', finalText, JSON.stringify(audit));
	return { ok: true, conversationId: convoId, message };
}
