<script lang="ts">
	import { fmtUSD } from '$lib/money';
	import { sliceColor } from './theme';

	// Dumb donut: fed precomputed slices (top rows + "Other"), renders arcs with
	// a center total. Colors follow slice rank, matching the ranked bars below.
	type Slice = { id: number | string | null; label: string; amount_cents: number; share: number };

	let {
		slices,
		total_cents,
		onslice
	}: {
		slices: Slice[];
		total_cents: number;
		onslice: (s: Slice) => void;
	} = $props();

	const R = 80;
	const THICK = 26;
	const C = 100;

	function arcPath(startFrac: number, endFrac: number): string {
		// pad each slice ~0.4% for the 2px surface gap; full-circle single slice
		const pad = slices.length > 1 ? 0.004 : 0;
		const a0 = 2 * Math.PI * (startFrac + pad) - Math.PI / 2;
		const a1 = 2 * Math.PI * (Math.max(endFrac - pad, startFrac + pad)) - Math.PI / 2;
		const r0 = R - THICK;
		const large = a1 - a0 > Math.PI ? 1 : 0;
		const p = (r: number, a: number) => `${C + r * Math.cos(a)} ${C + r * Math.sin(a)}`;
		return `M ${p(R, a0)} A ${R} ${R} 0 ${large} 1 ${p(R, a1)} L ${p(r0, a1)} A ${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z`;
	}

	// slices arrive as shares of the filtered total; normalize so the ring closes
	// even when tag shares overlap or rounding drifts
	const arcs = $derived.by(() => {
		const sum = slices.reduce((s, x) => s + x.amount_cents, 0);
		let acc = 0;
		return slices.map((s, i) => {
			const start = acc;
			acc += sum > 0 ? s.amount_cents / sum : 0;
			return { slice: s, i, start, end: acc };
		});
	});
</script>

<svg viewBox="0 0 200 200" role="img" aria-label="Breakdown donut">
	{#each arcs as a (a.i)}
		{@const clickable = a.slice.id !== null}
		<!-- only actionable slices are focusable buttons; Enter and Space both activate.
		     role/tabindex share the `clickable` predicate — the compiler can't see that statically -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<path
			d={arcPath(a.start, a.end)}
			fill={sliceColor(a.i, a.slice.id === null && a.slice.label === 'Other')}
			class="slice"
			class:clickable
			role={clickable ? 'button' : undefined}
			onclick={clickable ? () => onslice(a.slice) : undefined}
			onkeydown={clickable
				? (e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							onslice(a.slice);
						}
					}
				: undefined}
			tabindex={clickable ? 0 : undefined}
		>
			<title>{a.slice.label} · {fmtUSD(a.slice.amount_cents)} · {Math.round(a.slice.share * 100)}%</title>
		</path>
	{/each}
	<text x={C} y={C - 6} class="total">{fmtUSD(total_cents)}</text>
	<text x={C} y={C + 14} class="caption">total</text>
</svg>

<style>
	svg {
		width: 200px;
		height: 200px;
		flex-shrink: 0;
	}
	.slice {
		stroke: var(--color-surface);
		stroke-width: 2;
		transition: opacity var(--motion-base) var(--easing-standard);
	}
	svg:hover .slice:not(:hover) {
		opacity: 0.45;
	}
	.clickable {
		cursor: pointer;
	}
	.total {
		text-anchor: middle;
		font-family: var(--font-mono);
		font-size: 1rem;
		font-weight: 600;
		fill: var(--color-text-primary);
	}
	.caption {
		text-anchor: middle;
		font-size: 0.6875rem;
		fill: var(--color-text-muted);
	}
</style>
