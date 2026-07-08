<script lang="ts">
	import InfoTip from '$lib/InfoTip.svelte';
	import type { Snapshot } from '$lib/server/dashboard';

	let {
		data,
		anthropicReady,
		unavailable
	}: {
		data: NonNullable<Snapshot['insight']>;
		anthropicReady: boolean;
		unavailable: boolean;
	} = $props();
</script>

<!-- p3-06: the automatic monthly summary — generated once on the month's first launch -->
{#if data.summary}
	<div class="row-between" style="margin-bottom: var(--space-3);">
		<span class="row" style="gap: var(--space-2); align-items: center;">
			<span class="eyebrow">Last month, summarized</span>
			<InfoTip
				tip="Generated once on the month's first launch · {data.summary.model} · {data.summary.created_at.slice(0, 16)}"
			/>
		</span>
		<span class="t-body-sm t-muted">{data.summary.period}</span>
	</div>
	<p class="t-body-md insight-text" style="margin-bottom: var(--space-5);">
		{data.summary.narration}
	</p>
{/if}

<!-- p3-05: Insight — narration of the visible figures, never a source of them -->
<div class="row-between" style="margin-bottom: var(--space-3); flex-wrap: wrap; gap: var(--space-3);">
	<span class="row" style="gap: var(--space-2); align-items: center;">
		<span class="eyebrow">This month, explained</span>
		{#if data.explain}
			<InfoTip
				tip="Narrated from the dashboard figures · {data.explain.model} · {data.explain.created_at.slice(0, 16)} — the AI never computes or invents a number (figures come from the digest only)."
			/>
		{/if}
	</span>
	<form method="POST" action="?/explain">
		<button class="btn btn-secondary btn-sm" type="submit" disabled={!anthropicReady}>
			{data.explain ? 'Regenerate' : 'Explain this month'}
		</button>
	</form>
</div>
{#if unavailable}
	<p class="t-body-sm t-muted">
		Narration unavailable right now — the numbers above are unaffected. Try again later.
	</p>
{:else if data.explain}
	<p class="t-body-md insight-text">{data.explain.narration}</p>
{:else if !anthropicReady}
	<p class="t-body-sm t-muted">
		Narration unavailable — add an Anthropic API key in Settings to enable Insights. Every
		number on this page works without it.
	</p>
{:else}
	<p class="t-body-sm t-muted">
		No Insight for this month yet — generate one from the privacy-bounded digest (Category
		totals, trends, top Merchants; never balances, account numbers, or identity).
	</p>
{/if}

<style>
	.insight-text {
		white-space: pre-wrap;
		max-width: 72ch;
	}
</style>
