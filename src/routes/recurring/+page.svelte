<script lang="ts">
	import { fmtUSD } from '$lib/money';
	import { fmtDay } from '$lib/dates';
	import { BellOff, Bell, TrendingUp, TrendingDown } from '@lucide/svelte';
	import type { SeriesView } from '$lib/server/recurring-view';

	let { data, form } = $props();

	const PER: Record<string, string> = { weekly: '/wk', monthly: '/mo', annual: '/yr' };

	const ledgerHref = (merchant: string) => `/transactions?merchants=${encodeURIComponent(merchant)}`;

	// price creep: latest amount drifted off the series' typical amount
	const drift = (s: SeriesView) => s.last_amount_cents - s.typical_amount_cents;
</script>

{#snippet seriesRow(s: SeriesView)}
	<div class="row series-row">
		<a class="merchant" href={ledgerHref(s.merchant)}>{s.merchant}</a>
		{#if s.state === 'late'}
			<span class="chip" data-tone="warning">late — expected {fmtDay(s.next_expected)}</span>
		{:else if s.state === 'ended'}
			<span class="chip" data-tone="neutral">last seen {fmtDay(s.last_seen)}</span>
		{:else}
			<span class="t-body-sm t-muted">expected {fmtDay(s.next_expected)}</span>
		{/if}
		{#if drift(s) !== 0}
			<span class="chip" data-tone={drift(s) > 0 ? 'warning' : 'info'} title="price changed">
				{#if drift(s) > 0}<TrendingUp size={12} />{:else}<TrendingDown size={12} />{/if}
				was {fmtUSD(s.typical_amount_cents)}
			</span>
		{/if}
		<span class="amount">{fmtUSD(s.last_amount_cents)}<span class="t-muted">{PER[s.cadence]}</span></span>
		<form method="POST" action="?/mute">
			<input type="hidden" name="merchant" value={s.merchant} />
			<button class="btn btn-tertiary btn-sm btn-icon" type="submit" title="Not a bill — mute this merchant">
				<BellOff />
			</button>
		</form>
	</div>
{/snippet}

<header class="page-head">
	<span class="eyebrow">Recurring</span>
	<h1>Recurring</h1>
</header>

{#if form?.message}
	<div class="sync-banner" role="alert"><p class="t-body-sm">{form.message}</p></div>
{/if}

{#if data.view.active.length === 0 && data.view.ended.length === 0 && data.muted.length === 0}
	<section class="surface" style="padding: var(--space-8); text-align: center;">
		<p class="t-body-sm t-muted">
			Nothing recurring detected yet — a series needs three charges from the same merchant at a
			steady cadence and amount. Sync and check back.
		</p>
	</section>
{:else}
	<section class="surface headline">
		<span class="eyebrow">Committed monthly</span>
		<p class="committed">{fmtUSD(data.view.committed_monthly_cents)}<span class="t-muted">/mo</span></p>
		<p class="t-body-sm t-muted">
			Weekly and annual bills folded in at their monthly rate — each row below shows its real
			price and cadence. Ended and muted series aren't counted.
		</p>
	</section>

	<div class="surface list">
		{#each data.view.active as s (s.id)}
			{@render seriesRow(s)}
		{:else}
			<p class="t-body-sm t-muted" style="padding: var(--space-4);">No live series — everything detected has ended.</p>
		{/each}
	</div>

	{#if data.view.ended.length > 0}
		<details class="surface fold">
			<summary>Ended ({data.view.ended.length}) — no charge in two cycles, likely cancelled</summary>
			{#each data.view.ended as s (s.id)}
				{@render seriesRow(s)}
			{/each}
		</details>
	{/if}

	{#if data.muted.length > 0}
		<details class="surface fold">
			<summary>Muted ({data.muted.length}) — marked “not a bill”, skipped by detection</summary>
			{#each data.muted as m (m.merchant)}
				<div class="row series-row">
					<a class="merchant" href={ledgerHref(m.merchant)}>{m.merchant}</a>
					<span class="t-body-sm t-muted">muted {fmtDay(m.muted_at)}</span>
					<span class="amount"></span>
					<form method="POST" action="?/unmute">
						<input type="hidden" name="merchant" value={m.merchant} />
						<button class="btn btn-tertiary btn-sm btn-icon" type="submit" title="Unmute — let detection see this merchant again">
							<Bell />
						</button>
					</form>
				</div>
			{/each}
		</details>
	{/if}
{/if}

<style>
	.headline {
		padding: var(--space-6);
		margin-bottom: var(--space-4);
	}
	.committed {
		font-size: var(--text-3xl, 2rem);
		font-weight: 600;
		margin: var(--space-1) 0;
	}
	.list {
		padding: var(--space-2);
	}
	.series-row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-2) var(--space-3);
	}
	.series-row + .series-row {
		border-top: 1px solid var(--color-border);
	}
	.merchant {
		text-transform: capitalize;
		font-weight: 500;
		color: inherit;
		text-decoration: none;
	}
	.merchant:hover {
		text-decoration: underline;
	}
	.amount {
		margin-left: auto;
		font-variant-numeric: tabular-nums;
	}
	.fold {
		margin-top: var(--space-4);
		padding: var(--space-2) var(--space-3);
	}
	.fold summary {
		cursor: pointer;
		color: var(--color-text-secondary);
		font-size: var(--text-sm, 0.875rem);
		padding: var(--space-2);
	}
</style>
