<script lang="ts">
	import { fmtUSD } from '$lib/money';
	import TrendBars from '$lib/charts/TrendBars.svelte';
	import type { Snapshot } from '$lib/server/dashboard';

	let { data }: { data: NonNullable<Snapshot['spending-trend']> } = $props();

	const hasData = $derived(data.months.some((m) => m.total_cents > 0));
</script>

<div class="row-between" style="margin-bottom: var(--space-3);">
	<span class="eyebrow">Spending trend</span>
	<a class="btn btn-tertiary btn-sm" href="/reports">Reports →</a>
</div>

{#if hasData}
	<TrendBars data={data.months} height={160} />
	<p class="t-body-sm t-muted" style="margin-top: var(--space-2);">
		{fmtUSD(data.monthly_avg_cents)}/month average over the shown range
	</p>
{:else}
	<p class="t-body-sm t-muted">No spending recorded in the last twelve months.</p>
{/if}
