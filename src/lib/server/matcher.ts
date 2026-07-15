import type { ChargeFacts, ReceiptCandidate } from './gmail';

// Pure receipt matching (PRD matcher module): narrow query construction and
// candidate scoring. A Receipt is evidence, never proof — the threshold errs
// toward no-match over wrong-match. No db, no network, no mocks needed.

/**
 * Gmail query for one charge: exact amount string AND a bounded date window,
 * plus Merchant tokens when the Merchant yields any. Never a broad read.
 */
export function buildReceiptQuery(charge: ChargeFacts, windowDays: number): string {
	const amounts = amountRenderings(charge.amount_cents);
	// >= $1,000 prints as "1,234.56" in receipts but "1234.56" bare — query both
	const amountPart =
		amounts.length > 1 ? `(${amounts.map((a) => `"${a}"`).join(' OR ')})` : `"${amounts[0]}"`;
	const after = addDays(charge.date, -windowDays);
	const before = addDays(charge.date, windowDays + 1); // Gmail before: is exclusive
	const tokens = merchantTokens(charge.merchant);
	const merchantPart = tokens.length ? ` (${tokens.join(' OR ')})` : '';
	return `${amountPart}${merchantPart} after:${gmailDate(after)} before:${gmailDate(before)}`;
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
	const visible = `${c.subject} ${c.snippet}`;
	if (amountMatches(charge.amount_cents, visible)) score += 3;
	const haystack = `${c.from} ${c.subject}`.toLowerCase();
	if (merchantTokens(charge.merchant).some((t) => haystack.includes(t))) score += 2;
	return score;
}

/** Both renderings of a dollar amount: bare "1234.56" and comma-grouped "1,234.56". */
function amountRenderings(cents: number): string[] {
	const plain = (Math.abs(cents) / 100).toFixed(2);
	const grouped = plain.replace(/\B(?=(\d{3})+(?=\.))/g, ',');
	return grouped === plain ? [plain] : [plain, grouped];
}

/**
 * True if any rendering of the amount appears in `visible` on digit boundaries,
 * so "5.00" does NOT match inside "15.00" and "1,234.56" does not match inside
 * "11,234.56".
 */
function amountMatches(cents: number, visible: string): boolean {
	return amountRenderings(cents).some((a) => {
		const re = new RegExp(`(?<![\\d.,])${a.replace(/[.]/g, '\\.')}(?!\\d)`);
		return re.test(visible);
	});
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
