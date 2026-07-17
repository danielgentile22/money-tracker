import { db } from '$lib/server/db';
import {
	getSetting,
	putSetting as putSettingIn,
	deleteSetting as deleteSettingIn
} from '$lib/server/settings';
import { setMapping } from '$lib/server/categories';
import { groupedCategories } from '$lib/server/groups';
import { listTags, addTag, renameTag, deleteTag } from '$lib/server/tags';
import { DETECTORS, knobValues, detectorEnabled, runDetectors } from '$lib/server/detectors';
import { googleReady, listInboxes, beginEnrollment, revokeInbox } from '$lib/server/gmail';
import { anthropicReady, modelSetting, realLlm } from '$lib/server/llm';
import { realReceiptSource } from '$lib/server/gmail';
import {
	runCategorizationScan,
	runReceiptScan,
	isBackfilling,
	backfillProgress,
	receiptScanStats,
	hasConnectedInbox,
	scanCounts
} from '$lib/server/backfill';
import { householdContextBlock } from '$lib/server/assistant';
import { setSecret, deleteSecret } from '$lib/server/keychain';
import { WIDGETS, readLayout, saveLayout, readSidebar, saveSidebar } from '$lib/server/dashboard';
import { splitDisplayName } from '$lib/server/split-usage';
import { localToday } from '$lib/server/balances';
import { fail, redirect } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = ({ url }) => {
	const hasOverride = (key: string) => setting(key) != null;
	const detectors = DETECTORS.map((d) => {
		const values = knobValues(db, d);
		return {
			key: d.key,
			label: d.label,
			enabled: detectorEnabled(db, d.key),
			minFullMonths: d.minFullMonths ?? 0,
			knobs: d.knobs.map((k) => ({
				key: k.key,
				label: k.label,
				unit: k.unit,
				default: k.default,
				current: values[k.key],
				overridden: hasOverride(`detector_${d.key}_${k.key}`)
			}))
		};
	});
	// management moved to the Categories page (slice 5) — the tree only feeds
	// the Plaid-mapping picker now
	const tree = groupedCategories(db);
	const mappings = db
		.prepare(
			`SELECT m.plaid_key, m.category_id, c.name AS category_name
			 FROM plaid_category_map m JOIN categories c ON c.id = m.category_id
			 ORDER BY m.plaid_key`
		)
		.all() as { plaid_key: string; category_id: number; category_name: string }[];
	const thisYear = Number(localToday().slice(0, 4));
	const plans529 = (
		db.prepare("SELECT id, name FROM accounts WHERE subtype = '529' ORDER BY id").all() as {
			id: number;
			name: string;
		}[]
	).map((a) => {
		// stored as a birth year (#14); the form still shows "Age today" derived
		// from the current year, but persisting the year keeps it stable
		const birthYear = setting(`529_${a.id}_birth_year`) as string | undefined;
		return {
			...a,
			beneficiary: (setting(`529_${a.id}_name`) as string) ?? '',
			age: birthYear ? String(thisYear - Number(birthYear)) : '',
			target_dollars: (setting(`529_${a.id}_target_dollars`) as string) ?? '',
			override_monthly_dollars: (setting(`529_${a.id}_override_monthly_dollars`) as string) ?? ''
		};
	});
	const assumedReturn = (setting('assumed_return_pct') as string) ?? '5';

	// what each scan button would touch — scanCounts shares the scans' own
	// WHERE fragments, so the confirm popup's numbers match what actually runs
	const scanPreview = { all: scanCounts(db, 'all'), month: scanCounts(db, 'month') };

	return {
		widgets: WIDGETS,
		layout: readLayout(db),
		sidebar: readSidebar(db),
		splitLabel: splitDisplayName(db),
		tree,
		tags: listTags(db),
		mappings,
		detectors,
		plans529,
		assumedReturn,
		inboxes: listInboxes(),
		googleReady: googleReady(),
		inboxEnrolled: url.searchParams.get('inbox_enrolled'),
		inboxError: url.searchParams.get('inbox_error'),
		anthropicReady: anthropicReady(),
		backfilling: isBackfilling(),
		backfillProgress: backfillProgress(db),
		scanStats: receiptScanStats(db),
		scanPreview,
		proposerModel: modelSetting(db, 'proposer_model'),
		narratorModel: modelSetting(db, 'narrator_model'),
		assistantModel: modelSetting(db, 'assistant_model'),
		household: {
			dependents: setting('household_dependents') ?? '',
			income: setting('household_income') ?? '',
			filing_status: setting('household_filing_status') ?? ''
		},
		// the exact block the system prompt carries — inspectable, or null when unset
		householdBlock: householdContextBlock(db)
	};
};

// this route's settings access, bound to the singleton db (#83)
const setting = (key: string) => getSetting(db, key);
const putSetting = (key: string, value: string) => putSettingIn(db, key, value);
const deleteSetting = (key: string) => deleteSettingIn(db, key);

function act(fn: () => void) {
	try {
		fn();
		return { ok: true };
	} catch (e) {
		return fail(400, { message: e instanceof Error ? e.message : String(e) });
	}
}

export const actions: Actions = {
	// Session 6: dashboard + sidebar layout live here, auto-saved on every change
	layout: async ({ request }) => {
		const raw = String((await request.formData()).get('layout') ?? '');
		return act(() => saveLayout(db, JSON.parse(raw)));
	},
	sidebar: async ({ request }) => {
		const raw = String((await request.formData()).get('sidebar') ?? '');
		return act(() => saveSidebar(db, JSON.parse(raw)));
	},
	addTag: async ({ request }) => {
		const f = await request.formData();
		return act(() => void addTag(db, f.get('name') as string));
	},
	renameTag: async ({ request }) => {
		const f = await request.formData();
		return act(() => renameTag(db, Number(f.get('id')), f.get('name') as string));
	},
	deleteTag: async ({ request }) => {
		const f = await request.formData();
		return act(() => deleteTag(db, Number(f.get('id'))));
	},
	remap: async ({ request }) => {
		const f = await request.formData();
		return act(() => setMapping(db, f.get('plaid_key') as string, Number(f.get('category_id'))));
	},
	setKnob: async ({ request }) => {
		const f = await request.formData();
		const key = `detector_${f.get('detector')}_${f.get('knob')}`;
		const raw = (f.get('value') as string).trim();
		return act(() => {
			const n = Number(raw);
			if (raw === '' || !Number.isFinite(n)) throw new Error(`"${raw}" is not a number`);
			putSetting(key, String(n));
		});
	},
	resetKnob: async ({ request }) => {
		const f = await request.formData();
		const key = `detector_${f.get('detector')}_${f.get('knob')}`;
		return act(() => deleteSetting(key));
	},
	toggleDetector: async ({ request }) => {
		const f = await request.formData();
		const key = `detector_${f.get('detector')}_enabled`;
		return act(() => {
			if (f.get('enabled') === '0')
				putSetting(key, '0');
			else deleteSetting(key); // default = enabled
		});
	},
	rerunDetectors: async () => act(() => runDetectors(db)),
	// scans run minutes, not seconds — fire and forget; the page polls
	// /settings/scan-progress for the bar. Two independent scans, each scoped
	// 'all' or 'month'.
	categorizeScan: async ({ request }) => {
		const scope = String((await request.formData()).get('scope')) === 'month' ? 'month' : 'all';
		void runCategorizationScan(db, realLlm, scope).catch((e) =>
			console.error('categorization scan failed:', e)
		);
		return { ok: true };
	},
	receiptScan: async ({ request }) => {
		const scope = String((await request.formData()).get('scope')) === 'month' ? 'month' : 'all';
		if (!hasConnectedInbox(db))
			return { ok: false, message: 'no connected inbox — re-enroll Gmail below first' };
		void runReceiptScan(db, realReceiptSource, realLlm, scope).catch((e) =>
			console.error('receipt scan failed:', e)
		);
		return { ok: true };
	},
	save529: async ({ request }) => {
		const f = await request.formData();
		const id = Number(f.get('account_id'));
		return act(() => {
			const num = (field: string, opts: { min?: number; max?: number } = {}) => {
				const raw = (f.get(field) as string).trim();
				if (raw === '') return null;
				const n = Number(raw);
				if (!Number.isFinite(n) || n < (opts.min ?? 0) || n > (opts.max ?? Infinity))
					throw new Error(`${field} out of range`);
				return n;
			};
			const age = num('age', { max: 18 });
			const target = num('target_dollars');
			const override = num('override_monthly_dollars');
			putSetting(`529_${id}_name`, ((f.get('beneficiary') as string) ?? '').trim());
			// persist a birth year so the college year stays anchored to the child (#14)
			if (age != null)
				putSetting(`529_${id}_birth_year`, String(Number(localToday().slice(0, 4)) - age));
			if (target != null) putSetting(`529_${id}_target_dollars`, String(target));
			if (override != null) putSetting(`529_${id}_override_monthly_dollars`, String(override));
			else deleteSetting(`529_${id}_override_monthly_dollars`);
		});
	},
	enrollInbox: async ({ url }) => {
		let authUrl: string;
		try {
			authUrl = beginEnrollment(url.origin);
		} catch (e) {
			return fail(400, { message: e instanceof Error ? e.message : String(e) });
		}
		redirect(303, authUrl);
	},
	revokeInbox: async ({ request }) => {
		const f = await request.formData();
		await revokeInbox(Number(f.get('id')));
		return { ok: true };
	},
	setAnthropicKey: async ({ request }) => {
		const f = await request.formData();
		const key = ((f.get('key') as string) ?? '').trim();
		if (!key) return fail(400, { message: 'paste an API key first' });
		setSecret('anthropic-api-key', key);
		return { ok: true };
	},
	clearAnthropicKey: async () => {
		deleteSecret('anthropic-api-key');
		return { ok: true };
	},
	saveModels: async ({ request }) => {
		const f = await request.formData();
		return act(() => {
			for (const key of ['proposer_model', 'narrator_model', 'assistant_model'] as const) {
				const value = ((f.get(key) as string) ?? '').trim();
				if (value) putSetting(key, value);
				else deleteSetting(key); // back to default
			}
		});
	},
	// household context: owner-controlled personalization for the Assistant —
	// stored as plain settings, sent only when set, shown exactly as sent
	saveHousehold: async ({ request }) => {
		const f = await request.formData();
		return act(() => {
			for (const key of ['dependents', 'income', 'filing_status'] as const) {
				const value = ((f.get(key) as string) ?? '').trim();
				const setting = `household_${key}`;
				if (value) putSetting(setting, value);
				else deleteSetting(setting);
			}
		});
	},
	saveReturn: async ({ request }) => {
		const f = await request.formData();
		return act(() => {
			const n = Number((f.get('pct') as string).trim());
			if (!Number.isFinite(n)) throw new Error('return must be a number');
			putSetting('assumed_return_pct', String(n));
		});
	}
};
