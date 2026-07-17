import type { Database } from 'better-sqlite3';
import { monthSummary, shiftMonth, monthRange, type MonthSummary } from './analytics';
import { budgetMonth } from './budgets';
import { netWorthSeries, localToday } from './balances';
import { reportData } from './reports';
import { parseFilters } from './filters';
import { queryLedger } from './ledger';
import { activeConcerns, bucketFor, type Bucket } from './concerns';
import { runRateProjection, type RunRate, type Insufficient } from './projections';
import { getInsight, priorMonth, type InsightRow } from './insights';
import { dataQualityCounts } from './digest-common';
import { getSetting, putSetting } from './settings';
import { listRecaps } from './recap';

// Session 4: the widget registry — the one static list everything else is
// derived from. Session 6 (declutter): Apple-style S/M/L sizes — each widget
// declares which it supports — and a lean default set; the rest start hidden.
export type WidgetSize = 'small' | 'medium' | 'large';
export type WidgetDef = {
	id: string;
	name: string;
	sizes: WidgetSize[];
	defaultSize: WidgetSize;
	defaultHidden: boolean;
};

export const WIDGETS: WidgetDef[] = [
	{ id: 'month-summary', name: 'Month summary', sizes: ['medium', 'large'], defaultSize: 'large', defaultHidden: false },
	{ id: 'budget', name: 'Budget', sizes: ['small', 'medium', 'large'], defaultSize: 'medium', defaultHidden: false },
	{ id: 'net-worth', name: 'Net worth', sizes: ['small', 'medium', 'large'], defaultSize: 'medium', defaultHidden: false },
	{ id: 'concerns', name: 'Concerns', sizes: ['small', 'medium', 'large'], defaultSize: 'small', defaultHidden: false },
	{ id: 'spending-trend', name: 'Spending trend', sizes: ['medium', 'large'], defaultSize: 'medium', defaultHidden: true },
	{ id: 'recent-transactions', name: 'Recent transactions', sizes: ['medium', 'large'], defaultSize: 'medium', defaultHidden: true },
	{ id: 'run-rate', name: 'Run-rate projection', sizes: ['small', 'medium'], defaultSize: 'medium', defaultHidden: true },
	{ id: 'insight', name: 'Monthly insight', sizes: ['large'], defaultSize: 'large', defaultHidden: true },
	{ id: 'weekly-recap', name: 'Weekly recap', sizes: ['large'], defaultSize: 'large', defaultHidden: true }
];

export type LayoutEntry = { id: string; hidden: boolean; size: WidgetSize };

const KEY = 'dashboard_layout';

/** Saved JSON read leniently: anything non-array (absent, corrupt) is []. */
function readSaved(db: Database, key: string): unknown[] {
	const raw = getSetting(db, key);
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return []; // corrupt value reads as absent — the default, never an error
	}
}

/**
 * Persisted layout reconciled against the registry: unknown ids dropped
 * silently, unsupported sizes clamped to the widget's default, registry ids
 * missing from the saved layout appended at the end with their defaults.
 * Empty or absent setting yields the registry default order.
 */
export function readLayout(db: Database): LayoutEntry[] {
	const defs = new Map(WIDGETS.map((w) => [w.id, w]));
	const out: LayoutEntry[] = [];
	const seen = new Set<string>();
	for (const e of readSaved(db, KEY)) {
		const { id, hidden, size } = (e ?? {}) as LayoutEntry;
		const def = typeof id === 'string' ? defs.get(id) : undefined;
		if (!def || seen.has(def.id)) continue;
		seen.add(def.id);
		out.push({
			id: def.id,
			hidden: !!hidden,
			size: def.sizes.includes(size) ? size : def.defaultSize
		});
	}
	for (const w of WIDGETS)
		if (!seen.has(w.id)) out.push({ id: w.id, hidden: w.defaultHidden, size: w.defaultSize });
	return out;
}

/** Validated save: known ids only, no duplicates, supported sizes only. Throws on bad input. */
export function saveLayout(db: Database, layout: LayoutEntry[]): void {
	if (!Array.isArray(layout)) throw new Error('layout must be an array');
	const defs = new Map(WIDGETS.map((w) => [w.id, w]));
	const seen = new Set<string>();
	for (const e of layout) {
		const def = typeof e?.id === 'string' ? defs.get(e.id) : undefined;
		if (!def) throw new Error(`unknown widget: ${e?.id}`);
		if (seen.has(def.id)) throw new Error(`duplicate widget: ${def.id}`);
		if (!def.sizes.includes(e.size)) throw new Error(`unsupported size for ${def.id}: ${e.size}`);
		seen.add(def.id);
	}
	putSetting(
		db,
		KEY,
		JSON.stringify(layout.map((e) => ({ id: e.id, hidden: !!e.hidden, size: e.size })))
	);
}

// --- sidebar layout (Session 6) — same reconcile-against-registry pattern ---

// section hrefs only; labels/icons live client-side in the nav components
export const SECTIONS = [
	'/',
	'/transactions',
	'/categories',
	'/recurring',
	'/splits',
	'/reports',
	'/accounts',
	'/settings'
];

export type NavEntry = { id: string; hidden: boolean };

const NAV_KEY = 'sidebar_layout';

// slice 5: the Categories page replaced /budgets, so a stored '/budgets'
// entry becomes '/categories' in place — the owner's chosen spot survives.
const RENAMED: Record<string, string> = { '/budgets': '/categories' };

/** Settings is the escape hatch — it can never be hidden. */
export function readSidebar(db: Database): NavEntry[] {
	const known = new Set(SECTIONS);
	const out: NavEntry[] = [];
	const seen = new Set<string>();
	for (const e of readSaved(db, NAV_KEY)) {
		let { id, hidden } = (e ?? {}) as NavEntry;
		if (typeof id !== 'string') continue;
		id = RENAMED[id] ?? id;
		if (!known.has(id) || seen.has(id)) continue;
		seen.add(id);
		out.push({ id, hidden: id === '/settings' ? false : !!hidden });
	}
	for (const id of SECTIONS) if (!seen.has(id)) out.push({ id, hidden: false });
	return out;
}

export function saveSidebar(db: Database, entries: NavEntry[]): void {
	if (!Array.isArray(entries)) throw new Error('sidebar must be an array');
	const known = new Set(SECTIONS);
	const seen = new Set<string>();
	for (const e of entries) {
		if (typeof e?.id !== 'string' || !known.has(e.id)) throw new Error(`unknown section: ${e?.id}`);
		if (seen.has(e.id)) throw new Error(`duplicate section: ${e.id}`);
		seen.add(e.id);
	}
	putSetting(
		db,
		NAV_KEY,
		JSON.stringify(entries.map((e) => ({ id: e.id, hidden: e.id === '/settings' ? false : !!e.hidden })))
	);
}

/** Badge on the Transactions → Review fold-in link: open items only, all kinds. */
export function openReviewCount(db: Database): number {
	return dataQualityCounts(db).open_review_items;
}

export type Snapshot = {
	'month-summary'?: {
		month: string;
		current: MonthSummary;
		previous: MonthSummary;
		trailing: MonthSummary[];
	};
	budget?: {
		month: string;
		left_to_budget_cents: number;
		top: { name: string; emoji: string | null; budget_cents: number; actual_cents: number }[];
	};
	'net-worth'?: { series: { date: string; value_cents: number; estimated: number }[] };
	'spending-trend'?: {
		months: { month: string; total_cents: number }[];
		monthly_avg_cents: number;
	};
	'recent-transactions'?: {
		rows: {
			id: number;
			date: string;
			merchant: string | null;
			name: string;
			amount_cents: number;
			category_name: string | null;
		}[];
	};
	concerns?: {
		top: { id: number; title: string; severity: number; bucket: Bucket; narration: string | null }[];
		total: number;
	};
	'run-rate'?: { runRate: RunRate | Insufficient };
	insight?: { explain: InsightRow | null; summary: InsightRow | null };
	'weekly-recap'?: { recaps: InsightRow[] };
};

/**
 * Per-widget data for visible widgets only — hidden widgets' engines are
 * never consulted. Computes nothing itself; every slice delegates to the
 * engine that owns the number.
 */
export function buildSnapshot(db: Database, layout: LayoutEntry[], today = localToday()): Snapshot {
	const visible = new Set(layout.filter((e) => !e.hidden).map((e) => e.id));
	const month = today.slice(0, 7);
	const snap: Snapshot = {};

	if (visible.has('month-summary')) {
		const from = shiftMonth(month, -11);
		snap['month-summary'] = {
			month,
			current: monthSummary(db, month),
			previous: monthSummary(db, shiftMonth(month, -1)),
			trailing: monthRange(from, month).map((mo) => monthSummary(db, mo))
		};
	}

	if (visible.has('budget')) {
		const b = budgetMonth(db, month);
		snap.budget = {
			month,
			left_to_budget_cents: b.left_to_budget_cents,
			top: b.groups
				.flatMap((g) => g.lines)
				.filter((l) => l.actual_cents > 0 || l.budget_cents > 0)
				.sort((a, b2) => b2.actual_cents - a.actual_cents)
				.slice(0, 5)
				.map((l) => ({
					name: l.name,
					emoji: l.emoji,
					budget_cents: l.budget_cents,
					actual_cents: l.actual_cents
				}))
		};
	}

	if (visible.has('net-worth')) {
		snap['net-worth'] = {
			series: netWorthSeries(db).map((p) => ({
				date: p.date,
				value_cents: p.balance_cents,
				estimated: p.estimated
			}))
		};
	}

	if (visible.has('spending-trend')) {
		const r = reportData(
			db,
			parseFilters(new URLSearchParams('date=last-12-months')),
			'spending',
			'category',
			{ today, pageSize: 0 }
		);
		snap['spending-trend'] = { months: r.months, monthly_avg_cents: r.stats.monthly_avg_cents };
	}

	if (visible.has('recent-transactions')) {
		snap['recent-transactions'] = {
			rows: queryLedger(db, parseFilters(new URLSearchParams()), { today, limit: 8 }).map((r) => ({
				id: r.id,
				date: r.date,
				merchant: r.merchant,
				name: r.name,
				amount_cents: r.amount_cents,
				category_name: r.category_name
			}))
		};
	}

	if (visible.has('concerns')) {
		const all = activeConcerns(db);
		snap.concerns = {
			total: all.length,
			top: all.slice(0, 3).map((c) => ({
				id: c.id,
				title: c.title,
				severity: c.severity,
				bucket: bucketFor(c.severity),
				narration: c.narration
			}))
		};
	}

	if (visible.has('run-rate')) {
		snap['run-rate'] = { runRate: runRateProjection(db, today) };
	}

	if (visible.has('insight')) {
		snap.insight = {
			explain: getInsight(db, 'explain', month),
			summary: getInsight(db, 'summary', priorMonth(today))
		};
	}

	if (visible.has('weekly-recap')) {
		snap['weekly-recap'] = { recaps: listRecaps(db) };
	}

	return snap;
}
