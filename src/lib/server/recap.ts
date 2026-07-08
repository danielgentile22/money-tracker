import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { buildWeeklyDigest, isoWeekStart, shiftDays, type WeeklyDigest } from './weekly-digest';
import { getInsight, type InsightRow } from './insights';
import { LlmUnavailable, modelSetting, type Llm } from './llm';

// Session 5 Pass A: the Weekly Recap — a third insight kind, period-keyed by
// the ISO week's Monday. Same machinery as the monthly summary: digest →
// narrator model → stored row; digest-hash change detection so re-syncing an
// unchanged week regenerates nothing; fail-soft everywhere.

/** The ONE function that turns a weekly digest into a prompt — digest only, by construction. */
export function buildRecapPrompt(digest: WeeklyDigest): string {
	return [
		"You are recapping one week of a household's finances to its owner.",
		'Below is a digest of figures the app computed locally. It is your ONLY source:',
		'narrate these figures in plain English — never invent, recompute, or extrapolate a number.',
		'',
		'Cover: how the week went overall, what moved week-over-week (spend up or down,',
		'the biggest category shifts), and any large one-off transactions worth remarking on.',
		'',
		'If data_quality counts are non-zero, hedge the affected figures: open review items and',
		'unresolved charges mean totals may be understated or misassigned — say so briefly',
		'instead of narrating a suspicious figure with confidence.',
		'',
		'Aim for 60–110 words of prose. No headings, no bullet lists, no advice.',
		'',
		JSON.stringify(digest, null, 1)
	].join('\n');
}

/** Monday of the most recently completed ISO week (the week before today's). */
export function lastCompletedWeekStart(today: string): string {
	return shiftDays(isoWeekStart(today), -7);
}

const hash = (digest: WeeklyDigest) =>
	createHash('sha256').update(JSON.stringify(digest)).digest('hex');

/**
 * Generate + store the recap for the week starting `weekStart` — skipped
 * entirely when the stored row's digest hash still matches (re-syncing burns
 * nothing). Returns null on LLM unavailability (retry on a later sync).
 */
export async function generateRecap(
	db: Database,
	llm: Llm,
	weekStart: string
): Promise<InsightRow | null> {
	const digest = buildWeeklyDigest(db, weekStart);
	const digestHash = hash(digest);
	const stored = db
		.prepare("SELECT digest_hash FROM insights WHERE kind = 'recap' AND period = ?")
		.pluck()
		.get(weekStart) as string | undefined;
	if (stored === digestHash) return getInsight(db, 'recap', weekStart);

	const model = modelSetting(db, 'narrator_model');
	let narration: string;
	try {
		narration = (await llm({ model, prompt: buildRecapPrompt(digest), maxTokens: 500 })).trim();
	} catch (e) {
		if (e instanceof LlmUnavailable) return null;
		throw e;
	}
	if (!narration) return null;
	db.prepare(
		`INSERT INTO insights (kind, period, digest_hash, narration, model)
		 VALUES ('recap', ?, ?, ?, ?)
		 ON CONFLICT (kind, period) DO UPDATE SET
		   digest_hash = excluded.digest_hash, narration = excluded.narration,
		   model = excluded.model, created_at = datetime('now')`
	).run(weekStart, digestHash, narration, model);
	return getInsight(db, 'recap', weekStart);
}

/**
 * The sync hook: recap the most recently completed week if it's missing or
 * its data changed. No daemon — sync-on-launch is the scheduler.
 */
export async function runWeeklyRecap(
	db: Database,
	llm: Llm,
	today: string = new Date().toLocaleDateString('sv')
): Promise<void> {
	await generateRecap(db, llm, lastCompletedWeekStart(today));
}

/** Recent recaps, newest week first — the widget's flip-back history. */
export function listRecaps(db: Database, limit = 8): InsightRow[] {
	return db
		.prepare(
			`SELECT id, kind, period, narration, model, created_at
			 FROM insights WHERE kind = 'recap' ORDER BY period DESC LIMIT ?`
		)
		.all(limit) as InsightRow[];
}
