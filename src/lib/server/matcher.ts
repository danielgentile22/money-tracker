import type { ChargeFacts, ReceiptCandidate } from './gmail';

// Pure receipt matching (PRD matcher module): narrow query construction and
// candidate scoring. A Receipt is evidence, never proof — the threshold errs
// toward no-match over wrong-match. No db, no network, no mocks needed.

/**
 * Gmail query for one charge: exact amount string AND a bounded date window,
 * plus Merchant tokens when the Merchant yields any. Never a broad read.
 */
export function buildReceiptQuery(charge: ChargeFacts, windowDays: number): string {
	const amount = (Math.abs(charge.amount_cents) / 100).toFixed(2);
	const after = addDays(charge.date, -windowDays);
	const before = addDays(charge.date, windowDays + 1); // Gmail before: is exclusive
	const tokens = merchantTokens(charge.merchant);
	const merchantPart = tokens.length ? ` (${tokens.join(' OR ')})` : '';
	return `"${amount}"${merchantPart} after:${gmailDate(after)} before:${gmailDate(before)}`;
}

export type MatchOptions = { windowDays: number; minScore: number };

/**
 * Best candidate at or above minScore, or none. Signals: exact amount string
 * in subject/snippet (strong, +3), date proximity inside the window (+2 close,
 * +1 far), Merchant token in sender or subject (+2). Outside the window
 * disqualifies outright.
 */
export function matchReceipt(
	charge: ChargeFacts,
	candidates: readonly ReceiptCandidate[],
	opts: MatchOptions
): ReceiptCandidate | null {
	let best: ReceiptCandidate | null = null;
	let bestScore = 0;
	for (const c of candidates) {
		const score = scoreCandidate(charge, c, opts.windowDays);
		if (score >= opts.minScore && score > bestScore) {
			best = c;
			bestScore = score;
		}
	}
	return best;
}

export function scoreCandidate(
	charge: ChargeFacts,
	c: ReceiptCandidate,
	windowDays: number
): number {
	const dist = Math.abs(daysBetween(charge.date, c.date));
	if (dist > windowDays) return 0; // a coincidental amount far away is no evidence
	let score = dist <= 2 ? 2 : 1;
	const amount = (Math.abs(charge.amount_cents) / 100).toFixed(2);
	const visible = `${c.subject} ${c.snippet}`;
	if (visible.includes(amount)) score += 3;
	const haystack = `${c.from} ${c.subject}`.toLowerCase();
	if (merchantTokens(charge.merchant).some((t) => haystack.includes(t))) score += 2;
	return score;
}

function daysBetween(a: string, b: string): number {
	return (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;
}

function merchantTokens(merchant: string): string[] {
	return merchant
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length >= 3)
		.slice(0, 2);
}

function addDays(iso: string, days: number): string {
	const d = new Date(`${iso}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

function gmailDate(iso: string): string {
	return iso.replaceAll('-', '/');
}
