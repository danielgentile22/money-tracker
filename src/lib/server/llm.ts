import Anthropic from '@anthropic-ai/sdk';
import type { Database } from 'better-sqlite3';
import { getSecret, hasSecret } from './keychain';

// The single seam to the Anthropic API. Everything upstream (categorizer,
// extractor, insights) takes an Llm function so tests run on canned replies; the real
// one reads the key from the Keychain (ADR-0002):
//   set via Settings, or: security add-generic-password -s money-tracker -a anthropic-api-key -w <key>
// Models are settings with defaults: Sonnet everywhere (2026-07-05, was Haiku for receipts).

// #14: explicit per-request timeouts (TS SDK takes milliseconds; default is 10min).
// Interactive chat turns block a UI request; batch prompts (categorizer/extractor)
// tolerate more. One retry — fail-soft callers reschedule anyway.
const CHAT_TIMEOUT_MS = 60_000;
const BATCH_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 1;

export type LlmRequest = { model: string; system?: string; prompt: string; maxTokens: number };
export type Llm = (req: LlmRequest) => Promise<string>;

/** No key / network down / API error — callers fail soft and retry later. */
export class LlmUnavailable extends Error {}

export function anthropicReady(): boolean {
	return hasSecret('anthropic-api-key');
}

const MODEL_DEFAULTS: Record<string, string> = {
	proposer_model: 'claude-sonnet-5',
	narrator_model: 'claude-sonnet-5',
	assistant_model: 'claude-sonnet-5'
};

export function modelSetting(db: Database, key: keyof typeof MODEL_DEFAULTS & string): string {
	const raw = db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as
		| string
		| undefined;
	return raw?.trim() || MODEL_DEFAULTS[key];
}

// --- tool-loop variant (Session 5): same Keychain key, same fail-soft
// contract, same fake/real split — the Assistant engine is its only consumer.

export type ToolDef = { name: string; description: string; input_schema: Record<string, unknown> };
export type ToolCall = { id: string; name: string; input: unknown };
export type ChatTurn =
	| { role: 'user'; content: string }
	| { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
	| { role: 'tool'; results: { toolCallId: string; content: string }[] };
export type LlmChatRequest = {
	model: string;
	system: string;
	messages: ChatTurn[];
	tools: ToolDef[];
	maxTokens: number;
};
export type LlmChatReply = { text: string; toolCalls: ToolCall[] };
export type LlmChat = (req: LlmChatRequest) => Promise<LlmChatReply>;

export const realLlmChat: LlmChat = async ({ model, system, messages, tools, maxTokens }) => {
	const apiKey = getSecret('anthropic-api-key');
	if (!apiKey) throw new LlmUnavailable('no Anthropic API key in Keychain');
	const client = new Anthropic({ apiKey, timeout: CHAT_TIMEOUT_MS, maxRetries: MAX_RETRIES });
	const mapped: Anthropic.MessageParam[] = messages.map((m) => {
		if (m.role === 'user') return { role: 'user', content: m.content };
		if (m.role === 'assistant')
			return {
				role: 'assistant',
				content: [
					// #22: an empty assistant turn (no text, no tool calls) would render
					// as content: [] and 400 the whole conversation on replay
					...(m.content || !m.toolCalls?.length
						? [{ type: 'text' as const, text: m.content || '(no reply)' }]
						: []),
					...(m.toolCalls ?? []).map((c) => ({
						type: 'tool_use' as const,
						id: c.id,
						name: c.name,
						input: c.input as Record<string, unknown>
					}))
				]
			};
		return {
			role: 'user',
			content: m.results.map((r) => ({
				type: 'tool_result' as const,
				tool_use_id: r.toolCallId,
				content: r.content
			}))
		};
	});
	try {
		const res = await client.messages.create({
			model,
			max_tokens: maxTokens,
			system,
			messages: mapped,
			...(tools.length && { tools: tools as Anthropic.Tool[] })
		});
		// #62: a max_tokens stop means the reply (or a tool call) was cut mid-thought
		if (res.stop_reason === 'max_tokens')
			console.warn(`llm: chat reply truncated at max_tokens (model ${model})`);
		return {
			text: res.content
				.filter((b) => b.type === 'text')
				.map((b) => b.text)
				.join(''),
			toolCalls: res.content
				.filter((b) => b.type === 'tool_use')
				.map((b) => ({ id: b.id, name: b.name, input: b.input }))
		};
	} catch (e) {
		throw new LlmUnavailable(e instanceof Error ? e.message : String(e));
	}
};

export const realLlm: Llm = async ({ model, system, prompt, maxTokens }) => {
	const apiKey = getSecret('anthropic-api-key');
	if (!apiKey) throw new LlmUnavailable('no Anthropic API key in Keychain');
	const client = new Anthropic({ apiKey, timeout: BATCH_TIMEOUT_MS, maxRetries: MAX_RETRIES });
	try {
		const res = await client.messages.create({
			model,
			max_tokens: maxTokens,
			system,
			messages: [{ role: 'user', content: prompt }]
		});
		// #62: truncated categorizer/extractor replies parse as partial or bad JSON —
		// strict parsers already drop those rows, but make the cause visible
		if (res.stop_reason === 'max_tokens')
			console.warn(`llm: reply truncated at max_tokens (model ${model})`);
		return res.content
			.filter((b) => b.type === 'text')
			.map((b) => b.text)
			.join('');
	} catch (e) {
		// fail-soft everywhere (PRD): any API failure means "unavailable now,
		// retry on a later pass" — surfaces render without narration/Proposals
		throw new LlmUnavailable(e instanceof Error ? e.message : String(e));
	}
};
