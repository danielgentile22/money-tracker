<script lang="ts">
	import { fmtUSD } from '$lib/money';
	import InfoTip from '$lib/InfoTip.svelte';
	import type { Snapshot, WidgetSize } from '$lib/server/dashboard';

	let { data, size = 'medium' }: { data: NonNullable<Snapshot['run-rate']>; size?: WidgetSize } =
		$props();

	const rr = $derived(data.runRate);
	const tip =
		'Projected from the trailing 3 months of income minus spending; the 12-month figure is that rate carried forward.';
</script>

<div class="row-between" style="margin-bottom: var(--space-3);">
	<span class="row" style="gap: var(--space-2); align-items: center;">
		<span class="eyebrow">Savings run rate</span>
		<InfoTip {tip} />
	</span>
	{#if size !== 'small'}
		<a class="btn btn-tertiary btn-sm" href="/projections">Projections →</a>
	{/if}
</div>

{#if 'insufficient' in rr && rr.insufficient}
	<p class="t-body-sm t-muted">
		<span class="chip" data-tone="info">collecting · {rr.haveMonths}/{rr.needMonths} months</span>
	</p>
	{#if size !== 'small'}
		<p class="t-body-sm t-muted" style="margin-top: var(--space-2);">
			The projection needs more history before it says anything honest.
		</p>
	{/if}
{:else if !('insufficient' in rr)}
	<span class="stat-value">{fmtUSD(rr.monthly_net_cents)}</span>
	<p class="t-body-sm t-muted" style="margin-top: var(--space-2);">
		{#if size === 'small'}
			net / month
		{:else}
			projected net per month — {fmtUSD(rr.twelve_month_cents)} over 12 months
		{/if}
	</p>
{/if}
