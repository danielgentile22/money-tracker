<script lang="ts">
	import { fmtUSD } from '$lib/money';
	import ProgressBar from '$lib/charts/ProgressBar.svelte';
	import InfoTip from '$lib/InfoTip.svelte';
	import type { Snapshot, WidgetSize } from '$lib/server/dashboard';

	let { data, size = 'medium' }: { data: NonNullable<Snapshot['budget']>; size?: WidgetSize } =
		$props();

	const monthLabel = $derived(
		new Date(`${data.month}-15`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
	);
	const label = (l: { emoji: string | null; name: string }) =>
		l.emoji ? `${l.emoji} ${l.name}` : l.name;
	const tip =
		'Left to budget = expected income minus this month’s expense allocations. Zero is balanced; positive slack is the implicit savings plan.';
</script>

<div class="row-between" style="margin-bottom: var(--space-3);">
	<span class="eyebrow">Budget · {monthLabel}</span>
	{#if size === 'small'}
		<InfoTip {tip} />
	{:else}
		<a class="btn btn-tertiary btn-sm" href="/categories">Categories →</a>
	{/if}
</div>

{#if data.top.length === 0}
	<p class="t-body-sm t-muted">No budget or spending yet this month.</p>
{:else if size === 'small'}
	<!-- small tile: the one headline number, nothing else -->
	<a href="/categories" class="small-tile">
		<span class="stat-value" data-tone={data.left_to_budget_cents >= 0 ? 'success' : 'danger'}>
			{fmtUSD(data.left_to_budget_cents)}
		</span>
		<span class="t-body-sm t-muted">left to budget</span>
	</a>
{:else}
	<p class="t-body-sm" style="margin-bottom: var(--space-3);">
		<span class="t-mono" data-tone={data.left_to_budget_cents >= 0 ? 'success' : 'danger'}>
			{fmtUSD(data.left_to_budget_cents)}
		</span>
		<span class="t-muted">left to budget</span>
		<InfoTip {tip} />
	</p>
	<ul class="lines">
		{#each data.top as l (l.name)}
			<li>
				<span class="t-body-sm name">{label(l)}</span>
				{#if l.budget_cents > 0}
					<ProgressBar value={l.actual_cents} max={l.budget_cents} label={l.name} />
				{:else}
					<span class="bar-gap t-body-sm t-muted">unbudgeted</span>
				{/if}
				<span class="t-mono-sm amt">
					{fmtUSD(l.actual_cents)}{#if l.budget_cents > 0}&nbsp;<span class="t-muted">/ {fmtUSD(l.budget_cents)}</span>{/if}
				</span>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.small-tile {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		text-decoration: none;
	}
	.lines {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.lines li {
		display: grid;
		grid-template-columns: 9rem 1fr auto;
		align-items: center;
		gap: var(--space-3);
	}
	.name,
	.bar-gap {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.amt {
		text-align: right;
	}
</style>
