import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { listConversations } from '$lib/server/conversations';
import { runAssistantTurn } from '$lib/server/assistant';
import { realLlmChat } from '$lib/server/llm';
import type { RequestHandler } from './$types';

// The panel's API: the engine owns the exchange, these handlers only ferry.

export const GET: RequestHandler = () => json({ conversations: listConversations(db) });

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { conversationId?: number | null; text?: string };
	const text = String(body.text ?? '').trim();
	if (!text) return json({ message: 'empty message' }, { status: 400 });
	const conversationId = Number.isInteger(body.conversationId) ? (body.conversationId as number) : null;
	return json(await runAssistantTurn(db, realLlmChat, conversationId, text));
};
