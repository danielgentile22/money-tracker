import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { buildDigest, type Digest } from './digest';
import { activeConcerns } from './concerns';
import { LlmUnavailable, modelSetting, type Llm } from './llm';

// Insight narration (PRD insights module): digest → Claude → stored → rendered.
// Fail-soft everywhere — generation failure returns null, surfaces render
// their numbers and say "narration unavailable", the next trigger retries.

export type InsightKind = 'explain' | 'summary' | 'recap';

export type InsightRow = {
	id: number;
	kind: InsightKind;
	period: string;
	narration: string;
	model: string;
	created_at: string;
};

/** The ONE function that turns a digest into a prompt — digest only, by construction. */
export function buildNarrationPrompt(digest: Digest): string {
	return [
		'You are narrating one month of a household\'s finances to its owner.',
		'Below is a digest of figures the app computed locally. It is your ONLY source:',
		'narrate these figures in plain English — never invent, recompute, or extrapolate a number.',
		'',
		'If data_quality counts are non-zero, hedge the affected figures: open review items and',
		'unresolved charges mean the savings rate and category totals may be understated or',
		'misassigned until the owner works through them — say so briefly instead of narrating',
		'a suspicious figure with confidence.',
		'',
		'Mention a projection only alongside its stated assumptions.',
		'Aim for 120–180 words of prose. No headings, no bullet lists, no advice beyond what',
		'the concerns and projections themselves state.',
		'',
		JSON.stringify(digest, null, 1)
	].join('\n');
}

export function digestHash(digest: Digest): string {
	return createHash('sha256').update(JSON.stringify(digest)).digest('hex');
}

/**
 * Generate + store one Insight for a period; replaces the stored row for that
 * kind+period. Returns null on LLM unavailability (retry on the next trigger).
 */
export async function generateInsight(
	db: Database,
	llm: Llm,
	kind: InsightKind,
	period: string,
	today: string = new Date().toLocaleDateString('sv')
): Promise<InsightRow | null> {
	const digest = buildDigest(db, period, today);
	const model = modelSetting(db, 'narrator_model');
	let narration: string;
	try {
		narration = (
			await llm({ model, prompt: buildNarrationPrompt(digest), maxTokens: 1000 })
		).trim();
	} catch (e) {
		if (e instanceof LlmUnavailable) return null;
		throw e;
	}
	if (!narration) return null; // an empty reply narrates nothing
	db.prepare(
		`INSERT INTO insights (kind, period, digest_hash, narration, model)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (kind, period) DO UPDATE SET
		   digest_hash = excluded.digest_hash, narration = excluded.narration,
		   model = excluded.model, created_at = datetime('now')`
	).run(kind, period, digestHash(digest), narration, model);
	return getInsight(db, kind, period);
}

export function getInsight(db: Database, kind: InsightKind, period: string): InsightRow | null {
	return (
		(db
			.prepare(
				'SELECT id, kind, period, narration, model, created_at FROM insights WHERE kind = ? AND period = ?'
			)
			.get(kind, period) as InsightRow | undefined) ?? null
	);
}

// --- the automatic half (p3-06): on-launch catch-up, no daemon (PLAN.md) ---

export function priorMonth(today: string): string {
	const [y, m] = today.slice(0, 7).split('-').map(Number);
	return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/**
 * First launch of a new month generates the prior month's summary exactly once
 * (the stored row is the guard — relaunching regenerates nothing; a failed
 * generation stores nothing, so the next launch retries). Concern narration
 * rides the same pass and is idempotent by figures hash.
 */
export async function runMonthlyInsights(
	db: Database,
	llm: Llm,
	today: string = new Date().toLocaleDateString('sv')
): Promise<void> {
	const prior = priorMonth(today);
	if (!getInsight(db, 'summary', prior)) {
		await generateInsight(db, llm, 'summary', prior, today);
	}
	await narrateTopConcerns(db, llm);
}

/** One function builds the prompt: title + severity + figures — a strict subset of the digest. */
export function buildConcernPrompt(c: {
	title: string;
	severity: number;
	figures: Record<string, number | string>;
}): string {
	return [
		'One line of plain English for the owner of these family finances, narrating this',
		'concern the app detected. Use ONLY these figures — never invent or recompute a number.',
		'No advice beyond what the figures state. 25 words maximum, no preamble.',
		'',
		JSON.stringify({ title: c.title, severity: c.severity, figures: c.figures })
	].join('\n');
}

/**
 * Top active Concerns each get one stored line. Dismissed/expired never
 * narrate (they're not in the feed); a Concern that re-fires with changed
 * figures re-narrates on the next pass.
 */
// ponytail: "materially changed" = any figures change — a re-narrated line
// costs a fraction of a cent; add a threshold only if launches feel chatty.
export async function narrateTopConcerns(db: Database, llm: Llm, top = 3): Promise<void> {
	const model = modelSetting(db, 'narrator_model');
	const update = db.prepare(
		'UPDATE concerns SET narration = ?, narrated_figures_hash = ? WHERE id = ?'
	);
	for (const c of activeConcerns(db).slice(0, top)) {
		const hash = createHash('sha256').update(c.figures).digest('hex');
		if (c.narration && c.narrated_figures_hash === hash) continue;
		let line: string;
		try {
			line = (
				await llm({
					model,
					prompt: buildConcernPrompt({
						title: c.title,
						severity: c.severity,
						figures: JSON.parse(c.figures) as Record<string, number | string>
					}),
					maxTokens: 100
				})
			).trim();
		} catch (e) {
			if (e instanceof LlmUnavailable) return; // fail-soft: retry next launch
			throw e;
		}
		if (line) update.run(line, hash, c.id);
	}
}
