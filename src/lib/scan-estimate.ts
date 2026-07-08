// The confirm dialog behind every Gmail/AI button: what's about to happen, on
// how many Transactions, expected time and cost. Napkin math, Sonnet ballpark:
// a 100-charge categorizer batch ≈ $0.04; extracting + re-judging one matched
// Receipt ≈ $0.02. Gmail searches are free, ~1.2s each, 5 in parallel.
// enrichOnly: the Settings receipt scan extracts facts but never re-judges the
// Category — one AI call per match instead of two.
export type ScanPlan = { categorize: number; search: number; enrichOnly?: boolean };

export function scanPlanDetails(p: ScanPlan): { bullets: string[]; time: string } {
	const batches = Math.ceil(p.categorize / 100);
	const secs = (p.search * 1.2) / 5 + batches * 6;
	const bullets: string[] = [];
	if (p.categorize > 0)
		bullets.push(
			`AI-categorize ${p.categorize} transaction${p.categorize === 1 ? '' : 's'} — ${batches} batched call${batches === 1 ? '' : 's'}, ~$${(batches * 0.04).toFixed(2)}`
		);
	if (p.search > 0)
		bullets.push(
			`Search Gmail for receipts on ${p.search} charge${p.search === 1 ? '' : 's'} — free, read-only`,
			p.enrichOnly
				? `Each matched receipt: 1 AI call to extract its details, ~$0.01 per match — the Category is not changed`
				: `Each matched receipt: 2 more AI calls, ~$0.02 per match`
		);
	return { bullets, time: secs < 90 ? 'about a minute' : `~${Math.round(secs / 60)} min` };
}
