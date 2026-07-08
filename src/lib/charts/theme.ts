// Halo signal tokens for chart marks (PRD: indigo = primary series, lime =
// positive/saved, magenta = negative/overage, amber = warning). Hexes live in
// halo.css custom properties; Plot needs literals. Polarity pairs validated
// for CVD separation and surface contrast (dataviz six-checks, 2026-07-04);
// bars additionally encode polarity by position around the zero baseline.
export const INDIGO = '#5B6BFF';
export const LIME = '#2BE08C';
export const MAGENTA = '#FF3A5C';
export const AMBER = '#F5D547';

// Session 3 categorical palette for breakdown slices (donut, ranked bars,
// Sankey ribbons). Halo hues stepped into the dark-surface band and validated
// as a set (dataviz six-checks vs #14151C, 2026-07-04: worst adjacent CVD
// ΔE 18.2, all ≥3:1). Assigned by rank order, never cycled — rows past the
// 8th fold into "Other" (OTHER, neutral by intent).
export const CATEGORICAL = [
	'#5B6BFF', // indigo (brand)
	'#199E70', // green
	'#C98500', // gold
	'#D55181', // magenta
	'#1B9BBA', // cyan
	'#D95926', // orange
	'#9085E9', // violet
	'#008300' // deep green
];
export const OTHER = '#6E7687';

export const sliceColor = (i: number, isOther = false): string =>
	isOther ? OTHER : CATEGORICAL[i % CATEGORICAL.length];

/** Dollar axis ticks: $1.2k over $1,200 past a grand. */
export function fmtTick(d: number): string {
	return Math.abs(d) >= 1000 ? `$${(d / 1000).toLocaleString()}k` : `$${d.toLocaleString()}`;
}
