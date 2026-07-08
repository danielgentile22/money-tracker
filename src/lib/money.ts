export function fmtUSD(cents: number | null | undefined): string {
	return cents == null
		? '—'
		: (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
