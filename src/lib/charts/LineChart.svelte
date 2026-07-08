<script lang="ts">
	import * as Plot from '@observablehq/plot';
	import { INDIGO, AMBER, fmtTick } from './theme';

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
		// estimated segment includes the first real point so the line stays continuous
		const firstReal = data.find((d) => !d.estimated);
		const est = data.filter((d) => d.estimated).concat(firstReal ? [firstReal] : []);
		const real = data.filter((d) => !d.estimated);

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
				est.length > 1
					? Plot.lineY(est, {
							x: 'date',
							y: 'value',
							stroke: color,
							strokeWidth: 1.5,
							strokeDasharray: '4 4',
							strokeOpacity: 0.55
						})
					: null,
				real.length > 1
					? Plot.lineY(real, { x: 'date', y: 'value', stroke: color, strokeWidth: 2 })
					: null,
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
