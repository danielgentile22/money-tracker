// Pure Transfer pairing (ADR-0003): opposite-sign legs, equal amounts,
// different Accounts, within a date window, plus Plaid's transfer signal.
// No db, no mocks — fixtures in, decisions out.

export type TransferTxn = {
	id: number;
	account_id: number;
	date: string; // yyyy-mm-dd
	amount_cents: number; // owner-signed: negative = out
	transfer_signal: boolean; // Plaid says this looks like a transfer
};

export type PairingResult = {
	pairs: { outId: number; inId: number }[];
	/** multiple possible partners, or a Plaid-flagged leg with none (candidateIds empty) */
	ambiguous: { txnId: number; candidateIds: number[] }[];
};

const DAY_MS = 86_400_000;

function daysBetween(a: string, b: string): number {
	return Math.abs(Date.parse(a) - Date.parse(b)) / DAY_MS;
}

export function detectTransfers(
	txns: readonly TransferTxn[],
	opts: { windowDays: number }
): PairingResult {
	const pairs: PairingResult['pairs'] = [];
	const ambiguous: PairingResult['ambiguous'] = [];
	const used = new Set<number>();

	const outs = txns.filter((t) => t.amount_cents < 0).sort((a, b) => a.date.localeCompare(b.date));
	const ins = txns.filter((t) => t.amount_cents > 0);

	for (const out of outs) {
		const candidates = ins.filter(
			(i) =>
				!used.has(i.id) &&
				i.account_id !== out.account_id &&
				i.amount_cents === -out.amount_cents &&
				daysBetween(i.date, out.date) <= opts.windowDays
		);
		if (candidates.length === 1) {
			pairs.push({ outId: out.id, inId: candidates[0].id });
			used.add(out.id);
			used.add(candidates[0].id);
		} else if (candidates.length > 1) {
			ambiguous.push({ txnId: out.id, candidateIds: candidates.map((c) => c.id) });
		} else if (out.transfer_signal) {
			ambiguous.push({ txnId: out.id, candidateIds: [] });
		}
	}

	// Plaid-flagged in-legs that nothing claimed
	for (const i of ins) {
		if (i.transfer_signal && !used.has(i.id) && !ambiguous.some((a) => a.txnId === i.id)) {
			ambiguous.push({ txnId: i.id, candidateIds: [] });
		}
	}

	return { pairs, ambiguous };
}

// ponytail: subtype allowlist for "asset Account" (saved-marking). Extend if the
// owner's real accounts surface a different subtype at p1-11.
const ASSET_SUBTYPES = new Set([
	'savings',
	'cd',
	'money market',
	'529',
	'brokerage',
	'ira',
	'cash management' // some brokerages label the investment account this way
]);

export function isAssetAccount(type: string, subtype: string | null): boolean {
	return type === 'investment' || (subtype != null && ASSET_SUBTYPES.has(subtype.toLowerCase()));
}
