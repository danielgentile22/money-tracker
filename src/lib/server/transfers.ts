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
	const used = new Set<number>(); // auto-paired legs
	const contested = new Set<number>(); // in-legs offered as a review candidate — never auto-paired

	const outs = txns.filter((t) => t.amount_cents < 0).sort((a, b) => a.date.localeCompare(b.date));
	const ins = txns.filter((t) => t.amount_cents > 0);

	const matches = (out: TransferTxn, i: TransferTxn) =>
		i.account_id !== out.account_id &&
		i.amount_cents === -out.amount_cents &&
		daysBetween(i.date, out.date) <= opts.windowDays;

	// Symmetric (bipartite mutual-unique) matching: an out auto-pairs only when it
	// has exactly one candidate in AND that in is matched by exactly one out.
	// Two outs competing for one in — or one out with two ins — go to review, and
	// every candidate offered for review is reserved so no later out can claim it.
	const candidatesOf = new Map<number, TransferTxn[]>();
	const outsPerIn = new Map<number, number>();
	for (const out of outs) {
		const cands = ins.filter((i) => matches(out, i));
		candidatesOf.set(out.id, cands);
		for (const i of cands) outsPerIn.set(i.id, (outsPerIn.get(i.id) ?? 0) + 1);
	}

	for (const out of outs) {
		const cands = candidatesOf.get(out.id)!.filter((i) => !used.has(i.id));
		if (cands.length === 1 && outsPerIn.get(cands[0].id) === 1 && !contested.has(cands[0].id)) {
			pairs.push({ outId: out.id, inId: cands[0].id });
			used.add(out.id);
			used.add(cands[0].id);
		} else if (cands.length >= 1) {
			ambiguous.push({ txnId: out.id, candidateIds: cands.map((c) => c.id) });
			for (const c of cands) contested.add(c.id);
		} else if (out.transfer_signal) {
			ambiguous.push({ txnId: out.id, candidateIds: [] });
		}
	}

	// Plaid-flagged in-legs that nothing claimed — but not one already offered as
	// a candidate elsewhere (that would give the same leg two live judgment paths).
	for (const i of ins) {
		if (
			i.transfer_signal &&
			!used.has(i.id) &&
			!contested.has(i.id) &&
			!ambiguous.some((a) => a.txnId === i.id)
		) {
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
