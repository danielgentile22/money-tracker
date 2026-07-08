<script lang="ts">
	import { fmtUSD } from '$lib/money';
	import LineChart from '$lib/charts/LineChart.svelte';
	import Sparkline from '$lib/charts/Sparkline.svelte';
	import type { Snapshot, WidgetSize } from '$lib/server/dashboard';

	let { data, size = 'medium' }: { data: NonNullable<Snapshot['net-worth']>; size?: WidgetSize } =
		$props();

	const latest = $derived(data.series.at(-1));
	const spark = $derived(data.series.map((p) => p.value_cents));
</script>

<div class="row-between" style="margin-bottom: var(--space-3);">
	<span class="eyebrow">Net worth</span>
	{#if size !== 'small'}
		<a class="btn btn-tertiary btn-sm" href="/accounts">Accounts →</a>
	{/if}
</div>

{#if data.series.length <= 1}
	<p class="t-body-sm t-muted">The balance trend appears once a few days of history exist.</p>
{:else if size === 'small'}
	<!-- small tile: current value plus the shape of the trend -->
	<a href="/accounts" class="small-tile">
		<span class="stat-value">{fmtUSD(latest!.value_cents)}</span>
		<Sparkline values={spark} />
	</a>
{:else}
	<LineChart series={data.series} height={size === 'large' ? 280 : 220} />
{/if}

<style>
	.small-tile {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		text-decoration: none;
	}
</style>
