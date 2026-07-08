<script lang="ts">
	import { Info } from '@lucide/svelte';

	// methodology/provenance copy tucked behind an ⓘ — hover (or focus) to read
	let { tip }: { tip: string } = $props();
</script>

<!-- a span, not a button: it must be valid inside anchors (MonthSummary's stat tiles) -->
<span class="info-tip" data-tip={tip} role="note" aria-label={tip}>
	<Info />
</span>

<style>
	.info-tip {
		position: relative;
		display: inline-flex;
		align-items: center;
		color: var(--color-text-muted);
		cursor: help;
	}
	.info-tip :global(svg) {
		width: 14px;
		height: 14px;
	}
	.info-tip::after {
		content: attr(data-tip);
		position: absolute;
		top: calc(100% + 6px);
		left: 50%;
		transform: translateX(-50%);
		width: max-content;
		max-width: 280px;
		padding: var(--space-2) var(--space-3);
		background-color: var(--color-elevated);
		border: var(--border-width) solid var(--color-border-strong);
		border-radius: var(--radius-md);
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
		color: var(--color-text-secondary);
		font-size: var(--text-body-sm-size);
		line-height: 1.4;
		text-transform: none;
		letter-spacing: normal;
		white-space: normal;
		opacity: 0;
		pointer-events: none;
		transition: opacity var(--motion-base) var(--easing-standard);
		z-index: 10;
	}
	.info-tip:hover::after {
		opacity: 1;
	}
</style>
