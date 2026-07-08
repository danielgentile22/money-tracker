<script lang="ts">
	import * as Plot from '@observablehq/plot';
	import { INDIGO, fmtTick } from './theme';

	// Single-series monthly bars: the Reports trend chart (spending or income
	// magnitude per month for the filtered set).
	type Point = { month: string; total_cents: number };

	let { data, color = INDIGO, height = 180 }: { data: Point[]; color?: string; height?: number } =
		$props();
	let el: HTMLDivElement | undefined = $state();

	$effect(() => {
		if (!el || data.length === 0) return;
		const rows = data.map((d) => ({ month: d.month, total: d.total_cents / 100 }));
		const plot = Plot.plot({
			width: el.clientWidth || 640,
			height,
			marginLeft: 56,
			style: { background: 'transparent' },
			x: {
				type: 'band',
				tickSize: 0,
				label: null,
				// crowded ranges: label January and the first month, else MM
				tickFormat: (m: string) => (data.length > 14 && !m.endsWith('-01') ? '' : m.slice(5))
			},
			y: { grid: true, ticks: 4, tickSize: 0, label: null, tickFormat: fmtTick },
			marks: [
				Plot.barY(rows, { x: 'month', y: 'total', fill: color, rx: 3, insetLeft: 1, insetRight: 1 }),
				Plot.ruleY([0], { stroke: 'currentColor', strokeOpacity: 0.4 }),
				Plot.tip(
					rows,
					Plot.pointerX({
						x: 'month',
						y: 'total',
						title: (d: (typeof rows)[number]) => `${d.month}\n$${d.total.toLocaleString()}`
					})
				)
			]
		});
		el.replaceChildren(plot);
		return () => plot.remove();
	});
</script>

<div bind:this={el} class="chart"></div>

<style>
	.chart {
		color: var(--color-text-muted);
	}
	.chart :global(svg) {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
	}
	.chart :global([aria-label='tip'] path) {
		fill: var(--color-elevated);
		stroke: var(--color-border-strong);
	}
	.chart :global([aria-label='tip'] text) {
		fill: var(--color-text-primary);
	}
</style>
