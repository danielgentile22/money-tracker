// One dollar-input parser for every form action (#18): the rules and splits
// routes each had a hand-rolled copy and drifted — rules silently dropped
// '$40'-style input that splits accepted.

/** '$1,234.56' → 123456 cents; null when empty or unparseable. Sign preserved —
 * callers decide abs/positive-only. */
export function dollarsToCents(raw: FormDataEntryValue | null): number | null {
	const s = String(raw ?? '')
		.replace(/[$,]/g, '')
		.trim();
	if (!s) return null;
	const n = Number(s);
	return Number.isFinite(n) ? Math.round(n * 100) : null;
}
