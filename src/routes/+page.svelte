<script lang="ts">
	import MonthSummary from '$lib/widgets/MonthSummary.svelte';
	import Budget from '$lib/widgets/Budget.svelte';
	import NetWorth from '$lib/widgets/NetWorth.svelte';
	import SpendingTrend from '$lib/widgets/SpendingTrend.svelte';
	import RecentTransactions from '$lib/widgets/RecentTransactions.svelte';
	import Concerns from '$lib/widgets/Concerns.svelte';
	import RunRate from '$lib/widgets/RunRate.svelte';
	import Insight from '$lib/widgets/Insight.svelte';
	import WeeklyRecap from '$lib/widgets/WeeklyRecap.svelte';

	let { data, form } = $props();

	// Session 6: the dashboard is pure display — order, visibility, and size
	// are edited in Settings → Layout, never here
	const visible = $derived(data.layout.filter((e) => !e.hidden));
</script>

<header class="page-head">
	<div>
		<span class="eyebrow">Overview</span>
		<h1>Dashboard</h1>
	</div>
</header>

<!-- honesty banners: fixed chrome, outside the widget system, never hideable -->
{#if data.chrome.fullMonths < data.chrome.minFullMonths}
	<div class="sync-banner" role="status">
		<p class="t-body-sm">
			Collecting data — {data.chrome.fullMonths}/{data.chrome.minFullMonths} full months of
			history; most analytics need {data.chrome.minFullMonths}.
		</p>
	</div>
{/if}
{#if data.chrome.warmingCount > 0}
	<div class="sync-banner" role="status">
		<p class="t-body-sm">
			{data.chrome.warmingCount} Detector{data.chrome.warmingCount === 1 ? ' is' : 's are'} still
			warming up — quiet isn't all clear yet.
		</p>
	</div>
{/if}
{#if data.chrome.unreviewedTransfers > 0}
	<div class="sync-banner" role="status">
		<p class="t-body-sm">
			{data.chrome.unreviewedTransfers} unreviewed transfer candidate{data.chrome
				.unreviewedTransfers === 1
				? ''
				: 's'} may affect the savings figures —
			<a href="/review">review them</a>.
		</p>
	</div>
{/if}

<div class="grid">
	{#each visible as entry (entry.id)}
		<section class="surface widget" data-size={entry.size}>
			{#if entry.id === 'month-summary' && data.snapshot['month-summary']}
				<MonthSummary data={data.snapshot['month-summary']} />
			{:else if entry.id === 'budget' && data.snapshot.budget}
				<Budget data={data.snapshot.budget} size={entry.size} />
			{:else if entry.id === 'net-worth' && data.snapshot['net-worth']}
				<NetWorth data={data.snapshot['net-worth']} size={entry.size} />
			{:else if entry.id === 'spending-trend' && data.snapshot['spending-trend']}
				<SpendingTrend data={data.snapshot['spending-trend']} />
			{:else if entry.id === 'recent-transactions' && data.snapshot['recent-transactions']}
				<RecentTransactions data={data.snapshot['recent-transactions']} />
			{:else if entry.id === 'concerns' && data.snapshot.concerns}
				<Concerns data={data.snapshot.concerns} size={entry.size} />
			{:else if entry.id === 'run-rate' && data.snapshot['run-rate']}
				<RunRate data={data.snapshot['run-rate']} size={entry.size} />
			{:else if entry.id === 'insight' && data.snapshot.insight}
				<Insight
					data={data.snapshot.insight}
					anthropicReady={data.anthropicReady}
					unavailable={form?.unavailable ?? false}
				/>
			{:else if entry.id === 'weekly-recap' && data.snapshot['weekly-recap']}
				<WeeklyRecap data={data.snapshot['weekly-recap']} anthropicReady={data.anthropicReady} />
			{/if}
		</section>
	{/each}
</div>

<style>
	/* Apple-widget grid: small = 1 col, medium = 2, large = the full row */
	.grid {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: var(--space-4);
	}
	.widget {
		padding: var(--space-5);
		min-width: 0;
	}
	.widget[data-size='small'] {
		grid-column: span 1;
	}
	.widget[data-size='medium'] {
		grid-column: span 2;
	}
	.widget[data-size='large'] {
		grid-column: 1 / -1;
	}
	@media (max-width: 900px) {
		.grid {
			grid-template-columns: minmax(0, 1fr);
		}
		.widget[data-size] {
			grid-column: auto;
		}
	}
</style>
