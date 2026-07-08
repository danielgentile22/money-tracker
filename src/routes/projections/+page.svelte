<script lang="ts">
	import { fmtUSD } from '$lib/money';
	import LineChart from '$lib/charts/LineChart.svelte';

	let { data } = $props();
</script>

<header class="page-head">
	<span class="eyebrow">Analysis</span>
	<h1>Projections</h1>
</header>

<section class="surface panel">
	<div class="row-between" style="margin-bottom: var(--space-3); flex-wrap: wrap; gap: var(--space-3);">
		<span class="eyebrow">Net-savings run rate</span>
		{#if !data.runRate.insufficient}
			<span class="chip" data-tone={data.runRate.monthly_net_cents >= 0 ? 'success' : 'danger'}>
				{fmtUSD(data.runRate.monthly_net_cents)}/mo → {fmtUSD(data.runRate.twelve_month_cents)} over
				12 months
			</span>
		{/if}
	</div>

	{#if data.runRate.insufficient}
		<div style="padding: var(--space-6); text-align: center;">
			<span class="chip" data-tone="info">Collecting data</span>
			<p class="t-body-sm t-muted" style="margin-top: var(--space-3);">
				The run-rate Projection needs {data.runRate.needMonths} full months of history — {data
					.runRate.haveMonths} collected so far.
			</p>
		</div>
	{:else}
		<LineChart
			series={data.series}
			height={220}
			note="Dashed region is projected at the current run rate — an extrapolation, not a fact."
		/>
		<div class="assumptions">
			<span class="t-body-sm t-muted" style="text-transform: uppercase; letter-spacing: 0.04em;">
				Assumptions
			</span>
			<ul>
				{#each data.runRate.assumptions as a (a)}
					<li class="t-body-sm t-muted">{a}</li>
				{/each}
			</ul>
		</div>
	{/if}
</section>

{#each data.plans as p ('account_id' in p ? p.account_id : p)}
	{#if 'needsSetup' in p}
		<section class="surface panel" style="text-align: center; padding: var(--space-6);">
			<span class="chip" data-tone="info">Needs setup</span>
			<p class="t-body-sm t-muted" style="margin: var(--space-3) 0;">
				<strong>{p.account_name}</strong> has no 529 inputs yet — add the beneficiary's age and target
				college cost to project funding.
			</p>
			<a class="btn btn-secondary btn-sm" href="/settings">Open Settings</a>
		</section>
	{:else}
		<section class="surface panel">
			<div class="row-between" style="margin-bottom: var(--space-3); flex-wrap: wrap; gap: var(--space-3);">
				<span class="eyebrow">529 · {p.beneficiary}</span>
				<span class="row" style="gap: var(--space-2);">
					<span class="chip" data-tone={p.funded_pct >= 100 ? 'success' : p.funded_pct >= 70 ? 'warning' : 'danger'}>
						{p.funded_pct.toFixed(0)}% funded by {p.college_year}
					</span>
					{#if p.gap_cents > 0}
						<span class="chip" data-tone="neutral">gap {fmtUSD(p.gap_cents)}</span>
					{/if}
				</span>
			</div>
			{#if p.series.length > 1}
				<LineChart
					series={p.series}
					height={180}
					target={p.target_cents}
					note="Dashed path is projected; the amber rule is the target cost."
				/>
			{:else}
				<p class="t-body-sm t-muted">College year is here — no projection left to draw.</p>
			{/if}
			<div class="assumptions">
				<span class="t-body-sm t-muted" style="text-transform: uppercase; letter-spacing: 0.04em;">
					Assumptions
				</span>
				<ul>
					{#each p.assumptions as a (a)}
						<li class="t-body-sm t-muted">{a}</li>
					{/each}
				</ul>
			</div>
		</section>
	{/if}
{/each}

<section class="surface panel">
	<div class="row-between" style="margin-bottom: var(--space-3); flex-wrap: wrap; gap: var(--space-3);">
		<span class="eyebrow">Counterfactual savings</span>
		{#if data.counterfactual.lines.length > 0}
			<span class="chip" data-tone="warning">
				fix these, save ≈{fmtUSD(data.counterfactual.annual_cents)}/yr
			</span>
		{/if}
	</div>
	{#if data.counterfactual.lines.length === 0}
		<p class="t-body-sm t-muted">No flagged overages — nothing to counterfactual.</p>
	{:else}
		<ul class="cf-lines">
			{#each data.counterfactual.lines as l (l.concern_id)}
				<li class="row-between">
					<a class="t-body-sm cf-link" href="/concerns#concern-{l.concern_id}">{l.title}</a>
					<span class="t-mono-sm">{fmtUSD(l.overage_cents)}/mo</span>
				</li>
			{/each}
		</ul>
		<div class="assumptions">
			<span class="t-body-sm t-muted" style="text-transform: uppercase; letter-spacing: 0.04em;">
				Assumptions
			</span>
			<ul>
				{#each data.counterfactual.assumptions as a (a)}
					<li class="t-body-sm t-muted">{a}</li>
				{/each}
			</ul>
		</div>
	{/if}
</section>

<style>
	.panel {
		padding: var(--space-5);
		margin-bottom: var(--space-4);
	}
	.assumptions {
		margin-top: var(--space-4);
		padding-top: var(--space-3);
		border-top: var(--border-width) solid var(--color-border);
	}
	.assumptions ul {
		margin-top: var(--space-2);
		padding-left: var(--space-5);
		list-style: disc;
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	.cf-lines {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.cf-link {
		text-decoration: none;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.cf-link:hover {
		text-decoration: underline;
	}
</style>
