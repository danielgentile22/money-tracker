<script lang="ts">
	import { fmtUSD } from '$lib/money';
	import { sliceColor } from './theme';

	// Ranked horizontal bars, amounts labeled — precise comparison beyond the
	// donut's top slices. Same row order and colors as the donut (top rows keep
	// their slice color; the tail past the donut's cutoff reads neutral).
	type Row = { id: number | string | null; label: string; amount_cents: number; share: number };

	let {
		rows,
		colored = 8,
		onrow
	}: {
		rows: Row[];
		colored?: number; // rows beyond this rank wear the neutral tail color
		onrow?: (r: Row) => void;
	} = $props();

	const max = $derived(Math.max(...rows.map((r) => r.amount_cents), 1));
</script>

<div class="ranked">
	{#each rows as r, i (String(r.id) + r.label)}
		{@const Tag = onrow ? 'button' : 'div'}
		<svelte:element
			this={Tag}
			class="row"
			class:clickable={!!onrow}
			onclick={() => onrow?.(r)}
			role={onrow ? 'button' : undefined}
		>
			<span class="label" title={r.label}>{r.label}</span>
			<span class="track">
				<span
					class="bar"
					style="width: {(r.amount_cents / max) * 100}%; background: {sliceColor(i, i >= colored)};"
				></span>
			</span>
			<span class="amount t-mono-sm">{fmtUSD(r.amount_cents)}</span>
			<span class="share t-body-sm t-muted">{Math.round(r.share * 100)}%</span>
		</svelte:element>
	{/each}
	{#if rows.length === 0}
		<p class="t-body-sm t-muted">Nothing matches these filters.</p>
	{/if}
</div>

<style>
	.ranked {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		width: 100%;
	}
	.row {
		display: grid;
		grid-template-columns: 160px 1fr 90px 40px;
		gap: var(--space-3);
		align-items: center;
		padding: 2px var(--space-2);
		border: none;
		background: none;
		border-radius: var(--radius-sm, 6px);
		text-align: left;
		color: inherit;
		font: inherit;
	}
	.clickable {
		cursor: pointer;
	}
	.clickable:hover {
		background: var(--color-elevated);
	}
	.label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.8125rem;
	}
	.track {
		height: 14px;
		display: block;
	}
	.bar {
		display: block;
		height: 100%;
		border-radius: 0 4px 4px 0;
		min-width: 2px;
	}
	.amount {
		text-align: right;
	}
	.share {
		text-align: right;
	}
</style>
