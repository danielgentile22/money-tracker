// Monarch Session 3: the shared filter engine. One FilterSet vocabulary —
// include/exclude per dimension plus a date range — parsed from URLs,
// serialized back canonically, and compiled to SQL. Every analysis view
// (Reports, Cash Flow, Transactions) consumes this and nothing else.

export type IdFilter = { include?: number[]; exclude?: number[] };
export type MerchantFilter = { include?: string[]; exclude?: string[] };

export const DATE_PRESETS = ['this-month', 'last-3-months', 'ytd', 'last-12-months', 'all'] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];
export type DateFilter = { preset: DatePreset } | { from: string; to: string }; // ISO, inclusive

export type FilterSet = {
	categories?: IdFilter;
	groups?: IdFilter;
	accounts?: IdFilter;
	tags?: IdFilter;
	merchants?: MerchantFilter;
	date: DateFilter;
};

const ID_DIMS = ['categories', 'groups', 'accounts', 'tags'] as const;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function parseIds(params: URLSearchParams, key: string): number[] | undefined {
	const ids = [
		...new Set(
			params
				.getAll(key)
				.flatMap((v) => v.split(','))
				.map(Number)
				.filter((n) => Number.isInteger(n) && n > 0)
		)
	].sort((a, b) => a - b);
	return ids.length ? ids : undefined;
}

function parseNames(params: URLSearchParams, key: string): string[] | undefined {
	// merchants: repeated params, never comma-split (names may contain commas)
	const names = [...new Set(params.getAll(key).map((v) => v.trim()).filter(Boolean))].sort();
	return names.length ? names : undefined;
}

/** URL → FilterSet. Garbage-tolerant: unknown params ignored, malformed values dropped. */
export function parseFilters(params: URLSearchParams, defaultPreset: DatePreset = 'all'): FilterSet {
	const f: FilterSet = { date: { preset: defaultPreset } };
	for (const dim of ID_DIMS) {
		const include = parseIds(params, dim);
		const exclude = parseIds(params, `x${dim}`);
		if (include || exclude) f[dim] = { ...(include && { include }), ...(exclude && { exclude }) };
	}
	const include = parseNames(params, 'merchants');
	const exclude = parseNames(params, 'xmerchants');
	if (include || exclude) f.merchants = { ...(include && { include }), ...(exclude && { exclude }) };

	const preset = params.get('date') as DatePreset | null;
	const from = params.get('from');
	const to = params.get('to');
	if (preset && DATE_PRESETS.includes(preset)) f.date = { preset };
	else if (from && to && ISO.test(from) && ISO.test(to))
		f.date = from <= to ? { from, to } : { from: to, to: from };
	return f;
}

/** FilterSet → canonical query string (no leading '?'). Round-trip stable. */
export function serializeFilters(f: FilterSet): string {
	const q = new URLSearchParams();
	for (const dim of ID_DIMS) {
		const v = f[dim];
		if (v?.include?.length) q.set(dim, [...new Set(v.include)].sort((a, b) => a - b).join(','));
		if (v?.exclude?.length) q.set(`x${dim}`, [...new Set(v.exclude)].sort((a, b) => a - b).join(','));
	}
	for (const m of [...new Set(f.merchants?.include ?? [])].sort()) q.append('merchants', m);
	for (const m of [...new Set(f.merchants?.exclude ?? [])].sort()) q.append('xmerchants', m);
	if ('preset' in f.date) q.set('date', f.date.preset);
	else if (f.date.from <= f.date.to) (q.set('from', f.date.from), q.set('to', f.date.to));
	else (q.set('from', f.date.to), q.set('to', f.date.from));
	return q.toString();
}

/**
 * Resolve the date filter to inclusive ISO bounds against the local today.
 * Presets cover whole calendar months (monthly grain); 'all' is unbounded.
 */
export function resolveDateRange(
	date: DateFilter,
	today: string
): { from: string | null; to: string | null } {
	if (!('preset' in date)) return { from: date.from, to: date.to };
	const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
	const firstOfMonthsBack = (back: number) => {
		const n = y * 12 + (m - 1) - back;
		return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}-01`;
	};
	// last day of the current month, TZ-safe (pure UTC date-string math)
	const to = new Date(Date.parse(firstOfMonthsBack(-1)) - 86_400_000).toISOString().slice(0, 10);
	switch (date.preset) {
		case 'this-month':
			return { from: firstOfMonthsBack(0), to };
		case 'last-3-months':
			return { from: firstOfMonthsBack(2), to };
		case 'ytd':
			return { from: `${y}-01-01`, to };
		case 'last-12-months':
			return { from: firstOfMonthsBack(11), to };
		case 'all':
			return { from: null, to: null };
	}
}
