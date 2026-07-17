<script lang="ts">
	import { fmtDay } from '$lib/dates';
	import { ChevronLeft, ChevronRight } from '@lucide/svelte';
	import InfoTip from '$lib/InfoTip.svelte';
	import type { Snapshot } from '$lib/server/dashboard';

	let { data, anthropicReady }: { data: NonNullable<Snapshot['weekly-recap']>; anthropicReady: boolean } =
		$props();

	// newest week first; flipping back walks the retained history
	let index = $state(0);
	const recap = $derived(data.recaps[index]);

	function weekLabel(monday: string): string {
		const sunday = new Date(Date.parse(monday) + 6 * 86_400_000).toISOString().slice(0, 10);
		return `${fmtDay(monday)} – ${fmtDay(sunday)}`;
	}
</script>

<div class="row-between" style="margin-bottom: var(--space-3);">
	<span class="row" style="gap: var(--space-2); align-items: center;">
		<span class="eyebrow">Last week, recapped</span>
		{#if recap}
			<InfoTip
				tip="Generated on the week's first sync · {recap.model} · {recap.created_at.slice(0, 16)} — figures come from the weekly digest only; the AI never computes or invents a number."
			/>
		{/if}
	</span>
	{#if data.recaps.length > 0}
		<span class="row" style="gap: var(--space-2); align-items: center;">
			<button
				class="btn btn-tertiary btn-sm"
				onclick={() => (index = Math.min(index + 1, data.recaps.length - 1))}
				disabled={index >= data.recaps.length - 1}
				aria-label="Earlier week"
			>
				<ChevronLeft />
			</button>
			<span class="t-body-sm t-muted">{weekLabel(recap.period)}</span>
			<button
				class="btn btn-tertiary btn-sm"
				onclick={() => (index = Math.max(index - 1, 0))}
				disabled={index === 0}
				aria-label="Later week"
			>
				<ChevronRight />
			</button>
		</span>
	{/if}
</div>

{#if recap}
	<p class="t-body-md recap-text">{recap.narration}</p>
{:else if !anthropicReady}
	<p class="t-body-sm t-muted">
		No recap — add an Anthropic API key in Settings to enable the Weekly Recap. Everything else
		works without it.
	</p>
{:else}
	<p class="t-body-sm t-muted">
		No recap yet — the first one lands automatically on the first sync after a full
		Monday-to-Sunday week of data.
	</p>
{/if}

<style>
	.recap-text {
		white-space: pre-wrap;
		max-width: 72ch;
	}
</style>
