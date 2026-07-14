<script lang="ts">
	import * as Plot from '@observablehq/plot';
	import { INDIGO, AMBER, fmtTick } from './theme';
	import { segmentByEstimated } from './segments';

	type Point = { date: string; value_cents: number; estimated?: number };

	let {
		series,
		height = 140,
		color = INDIGO,
		target = null,
		note = 'Dashed region is estimated — reconstructed backwards through Transactions.'
	}: {
		series: Point[];
		height?: number;
		color?: string;
		target?: number | null; // horizontal reference (cents), e.g. a funding target
		note?: string | null;
	} = $props();

	let el: HTMLDivElement | undefined = $state();

	const hasEstimated = $derived(series.some((p) => p.estimated === 1));

	$effect(() => {
		if (!el || series.length < 2) return;
		const data = series.map((p) => ({
			date: new Date(p.date + 'T00:00:00'),
			value: p.value_cents / 100,
			estimated: p.estimated === 1
		}));
		// one line mark per contiguous run; estimated runs draw dashed and reach
		// into their real neighbors so the line stays continuous at any interleaving
		const lines = segmentByEstimated(data)
			.filter((run) => run.points.length > 1)
			.map((run) =>
				Plot.lineY(run.points, {
					x: 'date',
					y: 'value',
					stroke: color,
					strokeWidth: run.estimated ? 1.5 : 2,
					...(run.estimated ? { strokeDasharray: '4 4', strokeOpacity: 0.55 } : {})
				})
			);

		const plot = Plot.plot({
			width: el.clientWidth || 640,
			height,
			marginLeft: 56,
			style: { background: 'transparent' },
			x: { ticks: 4, tickSize: 0, label: null },
			y: { grid: true, ticks: 4, tickSize: 0, label: null, tickFormat: fmtTick },
			marks: [
				target != null
					? Plot.ruleY([target / 100], { stroke: AMBER, strokeDasharray: '2 4', strokeOpacity: 0.8 })
					: null,
				...lines,
				Plot.tip(
					data,
					Plot.pointerX({
						x: 'date',
						y: 'value',
						title: (d: (typeof data)[number]) =>
							`${d.date.toISOString().slice(0, 10)}\n$${d.value.toLocaleString('en-US', { minimumFractionDigits: 2 })}${d.estimated ? '\n(estimated)' : ''}`
					})
				)
			].filter(Boolean)
		});
		el.replaceChildren(plot);
		return () => plot.remove();
	});
</script>

<div bind:this={el} class="chart"></div>
{#if hasEstimated && note}
	<p class="t-body-sm t-muted" style="margin-top: var(--space-1);">{note}</p>
{/if}

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
