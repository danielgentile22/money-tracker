<script lang="ts">
	import { fmtUSD } from '$lib/money';
	import { fmtMonth } from '$lib/dates';
	import Sparkline from '$lib/charts/Sparkline.svelte';
	import InfoTip from '$lib/InfoTip.svelte';
	import type { Snapshot } from '$lib/server/dashboard';

	let { data }: { data: NonNullable<Snapshot['month-summary']> } = $props();

	const monthLabel = $derived(fmtMonth(data.month));
	const flowTone = $derived(data.current.cash_flow_cents >= 0 ? 'success' : 'danger');
	const flowDelta = $derived(
		data.previous.txn_count > 0 ? data.current.cash_flow_cents - data.previous.cash_flow_cents : null
	);
	const flowSpark = $derived(
		data.trailing.filter((t) => t.txn_count > 0).map((t) => t.cash_flow_cents)
	);
	const rateSpark = $derived(
		data.trailing.filter((t) => t.savings_rate != null).map((t) => t.savings_rate as number)
	);
	const rate = $derived(data.current.savings_rate);
	const prevRate = $derived(data.previous.savings_rate);
	const pct = (r: number) => `${(r * 100).toFixed(0)}%`;
	const monthEnd = $derived(`${data.month}-31`);
</script>

<div class="tiles">
	<a href="/transactions?from={data.month}-01&to={monthEnd}" class="stat-tile" data-tone={flowTone}>
		<div class="stat-head">
			<span class="stat-eyebrow">Cash flow · {monthLabel}</span>
			{#if flowDelta != null}
				<span class="chip" data-tone={flowDelta >= 0 ? 'success' : 'danger'}>
					{flowDelta >= 0 ? '▲' : '▼'} {fmtUSD(Math.abs(flowDelta))} vs last month
				</span>
			{/if}
		</div>
		<span class="stat-value">{fmtUSD(data.current.cash_flow_cents)}</span>
		<div class="stat-meta">
			<span class="stat-foot">
				{fmtUSD(data.current.income_cents)} in · {fmtUSD(data.current.expenses_cents)} out,
				month to date
			</span>
			<Sparkline values={flowSpark} />
		</div>
	</a>

	<a href="/review" class="stat-tile" data-tone="info">
		<div class="stat-head">
			<!-- the explicitly-saved metric (is_saved / income) — distinct from Cash
			     Flow's leftover-based savings rate; two honest numbers, two names -->
			<span class="stat-eyebrow">
				Moved to savings · {monthLabel}
				<InfoTip
					tip="Explicit contributions into savings, investment, or 529 Accounts, as a share of income — distinct from the Cash Flow savings rate (income minus expenses)."
				/>
			</span>
			{#if rate != null && prevRate != null}
				<span class="chip" data-tone={rate >= prevRate ? 'success' : 'warning'}>
					{rate >= prevRate ? '▲' : '▼'} {pct(prevRate)} last month
				</span>
			{/if}
		</div>
		<span class="stat-value">{rate == null ? '—' : pct(rate)}</span>
		<div class="stat-meta">
			<span class="stat-foot">
				{fmtUSD(data.current.saved_cents)} moved to savings this month
				{#if rate == null}&nbsp;· no income recorded yet{/if}
			</span>
			<Sparkline values={rateSpark} />
		</div>
	</a>
</div>

<style>
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
		gap: var(--space-4);
	}
	.tiles a {
		text-decoration: none;
	}
</style>
