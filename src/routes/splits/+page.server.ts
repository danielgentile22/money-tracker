import { db } from '$lib/server/db';
import {
	ensureSplitSchema,
	periodViews,
	recomputePeriod,
	splitSummary,
	splitDisplayName,
	invalidatePeriodBefore,
	realUsageFetch,
	type PeriodView
} from '$lib/server/split-usage';
import { dollarsToCents } from '$lib/server/form-utils';
import { fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';

ensureSplitSchema(db);

// Wired providers: claude today, codex when the first paid charge lands.
// Everything identity-shaped (names, patterns) lives in settings, never code.
const PROVIDERS = ['claude', 'codex'];

const setting = (key: string) =>
	db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as string | undefined;
const putSetting = (key: string, value: string) =>
	db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);

const sharePct = () => {
	const n = Number(setting('split_share_pct'));
	return Number.isFinite(n) && n > 0 && n <= 100 ? n : 50;
};
const patternFor = (provider: string) => setting(`split_project_pattern_${provider}`) ?? '';

export const load: PageServerLoad = async () => {
	const now = new Date();
	const withCharges = db
		.prepare('SELECT DISTINCT provider FROM split_charges ORDER BY provider')
		.pluck()
		.all() as string[];

	const errors: string[] = [];
	const periods: Record<string, PeriodView[]> = {};
	for (const provider of withCharges) {
		const r = await periodViews(db, provider, patternFor(provider), realUsageFetch, now);
		periods[provider] = r.views;
		if (r.error) errors.push(`${provider}: ${r.error}`);
	}
	const usageError = errors.length ? errors.join(' · ') : null;

	const payments = db
		.prepare(
			`SELECT p.id, p.date, p.amount_cents, p.note, p.transaction_id, t.name AS transaction_name
			 FROM split_payments p LEFT JOIN transactions t ON t.id = p.transaction_id
			 ORDER BY p.date DESC, p.id DESC`
		)
		.all() as {
		id: number;
		date: string;
		amount_cents: number;
		note: string | null;
		transaction_id: number | null;
		transaction_name: string | null;
	}[];

	// incoming money not yet linked — the pool for link-a-transaction and,
	// filtered by the payment pattern, the auto-match proposals
	const incoming = db
		.prepare(
			`SELECT id, date, name, amount_cents FROM transactions
			 WHERE amount_cents > 0 AND pending = 0 AND date >= date('now', '-120 days')
			   AND id NOT IN (SELECT transaction_id FROM split_payments WHERE transaction_id IS NOT NULL)
			 ORDER BY date DESC LIMIT 50`
		)
		.all() as { id: number; date: string; name: string; amount_cents: number }[];
	const payPattern = (setting('split_payment_pattern') ?? '').toLowerCase();
	const proposals = payPattern
		? incoming.filter((t) => t.name.toLowerCase().includes(payPattern))
		: [];

	return {
		displayName: splitDisplayName(db),
		partnerName: setting('split_partner_name') || 'Partner',
		sharePct: sharePct(),
		paymentPattern: setting('split_payment_pattern') ?? '',
		providers: PROVIDERS.map((p) => ({ id: p, pattern: patternFor(p) })),
		periods,
		summary: splitSummary(db, sharePct()),
		payments,
		incoming,
		proposals,
		usageError
	};
};

async function act(fn: () => void | Promise<void>) {
	try {
		await fn();
		return { ok: true };
	} catch (e) {
		return fail(400, { message: e instanceof Error ? e.message : String(e) });
	}
}

const positiveCents = (raw: FormDataEntryValue | null) => {
	const c = dollarsToCents(raw);
	if (c == null || c <= 0) throw new Error('amount must be a positive dollar value');
	return c;
};

const isoDate = (raw: FormDataEntryValue | null) => {
	const s = String(raw ?? '');
	if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('date required (yyyy-mm-dd)');
	return s;
};

export const actions = {
	addCharge: async ({ request }) => {
		const f = await request.formData();
		return act(() => {
			const provider = String(f.get('provider'));
			if (!PROVIDERS.includes(provider)) throw new Error('unknown provider');
			const date = isoDate(f.get('date'));
			db.transaction(() => {
				const id = db
					.prepare(
						'INSERT INTO split_charges (provider, date, amount_cents, note) VALUES (?, ?, ?, ?) RETURNING id'
					)
					.pluck()
					.get(provider, date, positiveCents(f.get('amount')), String(f.get('note') ?? '').trim() || null) as number;
				// the preceding period's window just ended at this charge — even a
				// backdated entry re-derives its (possibly frozen) predecessor
				invalidatePeriodBefore(db, provider, date, id);
			})();
		});
	},
	deleteCharge: async ({ request }) => {
		const f = await request.formData();
		return act(() => {
			const id = Number(f.get('id'));
			const charge = db
				.prepare('SELECT provider, date FROM split_charges WHERE id = ?')
				.get(id) as { provider: string; date: string } | undefined;
			if (!charge) throw new Error('no such charge');
			db.transaction(() => {
				// the preceding period's window just grew — drop its frozen result
				invalidatePeriodBefore(db, charge.provider, charge.date, id);
				db.prepare('DELETE FROM split_charges WHERE id = ?').run(id);
			})();
		});
	},
	recompute: async ({ request }) => {
		const f = await request.formData();
		const id = Number(f.get('id'));
		const provider = db
			.prepare('SELECT provider FROM split_charges WHERE id = ?')
			.pluck()
			.get(id) as string | undefined;
		if (!provider) return fail(400, { message: 'no such charge' });
		return act(() => recomputePeriod(db, id, patternFor(provider), realUsageFetch, new Date()));
	},
	addPayment: async ({ request }) => {
		const f = await request.formData();
		return act(() => {
			db.prepare('INSERT INTO split_payments (date, amount_cents, note) VALUES (?, ?, ?)').run(
				isoDate(f.get('date')),
				positiveCents(f.get('amount')),
				String(f.get('note') ?? '').trim() || null
			);
		});
	},
	// link-a-transaction and proposal Confirm share this: the payment takes the
	// transaction's own date and amount, nothing is ever matched silently
	linkPayment: async ({ request }) => {
		const f = await request.formData();
		return act(() => {
			const txn = db
				.prepare('SELECT id, date, name, amount_cents FROM transactions WHERE id = ?')
				.get(Number(f.get('transaction_id'))) as
				| { id: number; date: string; name: string; amount_cents: number }
				| undefined;
			if (!txn) throw new Error('no such transaction');
			if (txn.amount_cents <= 0) throw new Error('not an incoming transaction');
			// friendlier than the unique index's error on a double-submit
			if (db.prepare('SELECT 1 FROM split_payments WHERE transaction_id = ?').get(txn.id))
				throw new Error('that transaction is already linked to a repayment');
			db.prepare(
				'INSERT INTO split_payments (date, amount_cents, transaction_id, note) VALUES (?, ?, ?, ?)'
			).run(txn.date, txn.amount_cents, txn.id, txn.name);
		});
	},
	deletePayment: async ({ request }) => {
		const f = await request.formData();
		return act(() => void db.prepare('DELETE FROM split_payments WHERE id = ?').run(Number(f.get('id'))));
	},
	saveSettings: async ({ request }) => {
		const f = await request.formData();
		return act(() => {
			const save = (key: string, value: string) => {
				if (value) putSetting(key, value);
				else db.prepare('DELETE FROM settings WHERE key = ?').run(key);
			};
			save('split_display_name', String(f.get('display_name') ?? '').trim());
			save('split_partner_name', String(f.get('partner_name') ?? '').trim());
			const pct = String(f.get('share_pct') ?? '').trim();
			if (pct !== '') {
				const n = Number(pct);
				if (!Number.isFinite(n) || n <= 0 || n > 100) throw new Error('share % must be 1–100');
			}
			save('split_share_pct', pct);
			save('split_payment_pattern', String(f.get('payment_pattern') ?? '').trim());
			for (const provider of PROVIDERS) {
				const key = `split_project_pattern_${provider}`;
				const next = String(f.get(`pattern_${provider}`) ?? '').trim();
				if ((setting(key) ?? '') !== next) {
					// pattern changed → every stored share for the provider is wrong
					db.prepare(
						'DELETE FROM split_periods WHERE charge_id IN (SELECT id FROM split_charges WHERE provider = ?)'
					).run(provider);
				}
				save(key, next);
			}
		});
	}
} satisfies Actions;
