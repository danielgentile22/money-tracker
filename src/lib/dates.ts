// Shared date-label formatters (client + server), next of kin to money.ts's
// fmtUSD — one place instead of per-component re-declarations (#57).

/** 'YYYY-MM-DD' → localized day label; opts merge into the {month, day} default. */
export function fmtDay(iso: string, opts?: Intl.DateTimeFormatOptions): string {
	return new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
		...opts
	});
}

/** 'YYYY-MM' → 'July 2026' (long) or 'Jul' (short). Mid-month anchor is TZ-safe. */
export function fmtMonth(month: string, style: 'long' | 'short' = 'long'): string {
	return new Date(`${month}-15T00:00:00`).toLocaleDateString(
		'en-US',
		style === 'long' ? { month: 'long', year: 'numeric' } : { month: 'short' }
	);
}
