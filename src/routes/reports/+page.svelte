<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { fmtUSD } from '$lib/money';
	import FilterBar from '$lib/FilterBar.svelte';
	import Donut from '$lib/charts/Donut.svelte';
	import RankedBars from '$lib/charts/RankedBars.svelte';
	import TrendBars from '$lib/charts/TrendBars.svelte';
	import BalanceChart from '$lib/BalanceChart.svelte';
	import { INDIGO, LIME } from '$lib/charts/theme';

	let { data, form } = $props();

	const TABS = [
		{ id: 'spending', label: 'Spending' },
		{ id: 'income', label: 'Income' },
		{ id: 'networth', label: 'Net worth & trends' }
	];
	const GROUP_BYS = [
		{ id: 'group', label: 'Group' },
		{ id: 'category', label: 'Category' },
		{ id: 'merchant', label: 'Merchant' },
		{ id: 'tag', label: 'Tag' }
	];

	function withParams(mutate: (q: URLSearchParams) => void): string {
		const q = new URLSearchParams(page.url.searchParams);
		q.delete('page');
		mutate(q);
		return `?${q}`;
	}

	// donut slices: top 8 + "Other" (computed client-side from the full breakdown)
	const slices = $derived.by(() => {
		const b = data.report?.breakdown ?? [];
		if (b.length <= 8) return b;
		const rest = b.slice(8);
		return [
			...b.slice(0, 8),
			{
				id: null,
				label: 'Other',
				amount_cents: rest.reduce((s, r) => s + r.amount_cents, 0),
				share: rest.reduce((s, r) => s + r.share, 0)
			}
		];
	});

	// slice/bar click = add that value to the filter (story 22)
	function drill(s: { id: number | string | null; label: string }) {
		if (s.id == null) return; // "Other" / Uncategorized / Untagged: nothing to add
		const KEY: Record<string, string> = {
			group: 'groups',
			category: 'categories',
			tag: 'tags',
			merchant: 'merchants'
		};
		goto(
			withParams((q) => {
				const key = KEY[data.by];
				if (key === 'merchants') {
					q.delete('merchants');
					q.append('merchants', String(s.id));
				} else q.set(key, String(s.id));
				q.delete(`x${key}`);
			}),
			{ noScroll: true }
		);
	}
</script>

<header class="page-head">
	<span class="eyebrow">Analysis</span>
	<h1>Reports</h1>
</header>

{#if form?.message}
	<div class="sync-banner" role="alert"><p class="t-body-sm">{form.message}</p></div>
{/if}

<nav class="row tabs" style="gap: var(--space-2); margin-bottom: var(--space-4);">
	{#each TABS as t (t.id)}
		<a
			class="btn btn-sm {data.tab === t.id ? 'btn-primary' : 'btn-secondary'}"
			href={withParams((q) => q.set('tab', t.id))}
			aria-current={data.tab === t.id ? 'page' : undefined}
		>
			{t.label}
		</a>
	{/each}
</nav>

<FilterBar
	tree={data.tree}
	accounts={data.accounts}
	tags={data.allTags}
	merchants={data.merchants}
	saved={data.saved}
	defaultPreset="last-12-months"
/>

{#if data.tab === 'networth'}
	<section class="surface" style="padding: var(--space-5);">
		<h2 class="t-title-md" style="margin-bottom: var(--space-3);">Net worth</h2>
		{#if (data.netWorth ?? []).length < 2}
			<p class="t-body-sm t-muted">
				Not enough Snapshots in this window — widen the date range or run a sync.
			</p>
		{:else}
			<BalanceChart series={data.netWorth ?? []} height={220} />
		{/if}
		<p class="t-body-sm t-muted" style="margin-top: var(--space-2);">
			Balance snapshots over the selected range. Account filters apply; other dimensions don't
			mean anything for balances and are ignored.
		</p>
	</section>
{:else if data.report}
	{@const r = data.report}
	<div class="stats-row">
		<div class="surface stat">
			<span class="t-body-sm t-muted">Total</span>
			<span class="t-mono stat-num">{fmtUSD(r.stats.total_cents)}</span>
		</div>
		<div class="surface stat">
			<span class="t-body-sm t-muted">Monthly average</span>
			<span class="t-mono stat-num">{fmtUSD(r.stats.monthly_avg_cents)}</span>
		</div>
		<div class="surface stat">
			<span class="t-body-sm t-muted">Transactions</span>
			<span class="t-mono stat-num">{r.stats.txn_count.toLocaleString()}</span>
		</div>
	</div>

	<section class="surface" style="padding: var(--space-5); margin-bottom: var(--space-4);">
		<h2 class="t-title-md" style="margin-bottom: var(--space-3);">
			Monthly {data.tab === 'spending' ? 'spending' : 'income'}
		</h2>
		<TrendBars data={r.months} color={data.tab === 'income' ? LIME : INDIGO} />
	</section>

	<section class="surface" style="padding: var(--space-5); margin-bottom: var(--space-4);">
		<div class="row-between" style="margin-bottom: var(--space-3);">
			<h2 class="t-title-md">Breakdown</h2>
			<label class="field" style="flex-direction: row; align-items: center; gap: var(--space-2);">
				<span class="field-label" style="margin: 0;">Group by</span>
				<select
					class="select"
					value={data.by}
					onchange={(e) => goto(withParams((q) => q.set('by', e.currentTarget.value)), { noScroll: true })}
				>
					{#each GROUP_BYS as g (g.id)}
						<option value={g.id}>{g.label}</option>
					{/each}
				</select>
			</label>
		</div>
		{#if r.breakdown.length === 0}
			<p class="t-body-sm t-muted">Nothing matches these filters.</p>
		{:else}
			<div class="breakdown">
				<Donut {slices} total_cents={r.stats.total_cents} onslice={drill} />
				<RankedBars rows={r.breakdown} onrow={drill} />
			</div>
			{#if data.by === 'tag' && r.breakdown.length > 1}
				<p class="t-body-sm t-muted" style="margin-top: var(--space-2);">
					A Transaction can carry several Tags, so tag rows may sum past the total.
				</p>
			{/if}
		{/if}
	</section>

	<section class="surface ledger" style="margin-bottom: var(--space-4);">
		<div class="row-between" style="padding: var(--space-4) var(--space-4) 0;">
			<h2 class="t-title-md">Matching Transactions</h2>
			<a class="btn btn-tertiary btn-sm" href="/transactions?{data.filterQuery}">
				Open in Transactions
			</a>
		</div>
		<table>
			<thead>
				<tr>
					<th>Date</th>
					<th>Merchant</th>
					<th>Category</th>
					<th>Account</th>
					<th class="num">Amount</th>
				</tr>
			</thead>
			<tbody>
				{#each r.rows as row (row.id)}
					<tr>
						<td class="t-mono-sm t-muted">{row.date}</td>
						<td>{row.merchant ?? row.name}</td>
						<td class="t-body-sm">{row.category_name ?? '—'}</td>
						<td class="t-body-sm t-muted">{row.account_name}</td>
						<td class="num t-mono-sm" class:pos={row.amount_cents > 0} class:neg={row.amount_cents < 0}>
							{fmtUSD(row.amount_cents)}
						</td>
					</tr>
				{:else}
					<tr><td colspan="5" class="t-body-sm t-muted">No matching Transactions.</td></tr>
				{/each}
			</tbody>
		</table>
	</section>
	<nav class="row-between" style="margin-bottom: var(--space-4);">
		<span class="t-body-sm t-muted">Page {data.page}</span>
		<span class="row" style="gap: var(--space-2);">
			{#if data.page > 1}
				<a
					class="btn btn-secondary btn-sm"
					href={`?${(() => { const q = new URLSearchParams(page.url.searchParams); q.set('page', String(data.page - 1)); return q; })()}`}
				>
					Previous
				</a>
			{/if}
			{#if r.hasMore}
				<a
					class="btn btn-secondary btn-sm"
					href={`?${(() => { const q = new URLSearchParams(page.url.searchParams); q.set('page', String(data.page + 1)); return q; })()}`}
				>
					Next
				</a>
			{/if}
		</span>
	</nav>
{/if}

<style>
	.stats-row {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: var(--space-3);
		margin-bottom: var(--space-4);
	}
	.stat {
		padding: var(--space-4);
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	.stat-num {
		font-size: 1.25rem;
		font-weight: 600;
	}
	.breakdown {
		display: flex;
		gap: var(--space-6);
		align-items: flex-start;
	}
	.ledger table {
		width: 100%;
	}
</style>
