import type { Database } from 'better-sqlite3';
import type { ReceiptCandidate } from './gmail';
import { LlmUnavailable, modelSetting, type Llm } from './llm';

// Layer-1 enrichment (enrich-then-categorize PRD): matched Receipt email in →
// structured facts out. buildExtractorPrompt is the ADR-0001 boundary for this
// call: the matched email's headers + capped body (snippet when no body) are
// the only things that reach the model. Strict parse: anything but a clean,
// in-schema reply yields null — the match stands, the facts stay empty.

export type ReceiptFacts = {
	description: string; // one line: what the purchase was for
	vendor: string | null; // the vendor's own name for itself
	items: { name: string; price_cents: number | null }[];
};

export function buildExtractorPrompt(
	receipt: Pick<ReceiptCandidate, 'from' | 'subject' | 'date' | 'snippet' | 'body'>
): string {
	return [
		'Extract what this receipt email says the purchase was for. Judge only from the email below.',
		'',
		`From: ${receipt.from}`,
		`Subject: ${receipt.subject}`,
		`Date: ${receipt.date}`,
		receipt.body ? `Body:\n${receipt.body}` : `Snippet: ${receipt.snippet}`,
		'',
		'Reply with JSON only, no other text:',
		'{"description": "<one short line: what it was for>", "vendor": "<the vendor\'s own name, if stated>", "items": [{"name": "<line item>", "price": <dollars, only when shown>}]}',
		'Omit "items" when the email lists none; omit "price" when not shown.'
	].join('\n');
}

/**
 * Extract facts from a Transaction's matched Receipt and store them on the
 * row. Every failure mode (bad reply, LLM down, no match) leaves facts NULL
 * and the match intact — enrichment never blocks anything downstream.
 */
export async function enrichTransaction(db: Database, llm: Llm, txnId: number): Promise<void> {
	const json = db
		.prepare("SELECT receipt_json FROM transactions WHERE id = ? AND receipt_search_state = 'matched'")
		.pluck()
		.get(txnId) as string | undefined;
	if (!json) return;
	// #61: a malformed stored receipt_json skips enrichment instead of throwing
	let receipt: ReceiptCandidate;
	try {
		receipt = JSON.parse(json) as ReceiptCandidate;
	} catch {
		return;
	}
	let reply: string;
	try {
		reply = await llm({
			model: modelSetting(db, 'proposer_model'),
			prompt: buildExtractorPrompt(receipt),
			maxTokens: 700
		});
	} catch (e) {
		if (e instanceof LlmUnavailable) return;
		throw e;
	}
	const facts = parseFacts(reply);
	db.prepare('UPDATE transactions SET receipt_facts_json = ? WHERE id = ?').run(
		facts ? JSON.stringify(facts) : null,
		txnId
	);
}

export function parseFacts(reply: string): ReceiptFacts | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(reply.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null) return null;
	const { description, vendor, items } = parsed as {
		description?: unknown;
		vendor?: unknown;
		items?: unknown;
	};
	if (typeof description !== 'string' || !description.trim()) return null;
	return {
		description: description.trim(),
		vendor: typeof vendor === 'string' && vendor.trim() ? vendor.trim() : null,
		items: (Array.isArray(items) ? items : []).flatMap((it) => {
			if (typeof it !== 'object' || it === null) return [];
			const { name, price } = it as { name?: unknown; price?: unknown };
			if (typeof name !== 'string' || !name.trim()) return [];
			return [
				{
					name: name.trim(),
					price_cents: typeof price === 'number' && Number.isFinite(price) ? Math.round(price * 100) : null
				}
			];
		})
	};
}
