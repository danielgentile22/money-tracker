<script lang="ts">
	// Actual-vs-target bar: success under target, warning near it, danger over.
	// Tone is never color-only (owner is red-green colorblind): warning and
	// danger switch to a striped fill, and danger adds a ▲ marker at the end.
	let {
		value,
		max,
		label = ''
	}: { value: number; max: number; label?: string } = $props();

	const frac = $derived(max > 0 ? value / max : 0);
	const tone = $derived(frac > 1 ? 'danger' : frac >= 0.85 ? 'warning' : 'success');
	const state = $derived(
		tone === 'danger' ? ' — over target' : tone === 'warning' ? ' — near target' : ''
	);
</script>

<div
	class="progress"
	role="progressbar"
	aria-valuenow={Math.min(value, max)}
	aria-valuemin={0}
	aria-valuemax={max}
	aria-valuetext="{value} of {max}{state}"
	aria-label={label}
>
	<div class="fill" data-tone={tone} style="width: {Math.min(frac, 1) * 100}%;"></div>
	{#if tone === 'danger'}
		<span class="over-marker" aria-hidden="true">▲</span>
	{/if}
</div>

<style>
	.progress {
		position: relative;
		height: 6px;
		border-radius: var(--radius-full);
		background-color: var(--color-elevated);
	}
	.fill {
		height: 100%;
		max-width: 100%;
		border-radius: var(--radius-full);
		background-color: var(--color-success);
		transition: width var(--motion-base) var(--easing-standard);
	}
	/* warning/danger get a stripe pattern so tone survives without color */
	.fill[data-tone='warning'],
	.fill[data-tone='danger'] {
		background-image: repeating-linear-gradient(
			-45deg,
			rgb(0 0 0 / 0.35) 0 3px,
			transparent 3px 6px
		);
	}
	.fill[data-tone='warning'] {
		background-color: var(--color-warning);
	}
	.fill[data-tone='danger'] {
		background-color: var(--color-danger);
	}
	.over-marker {
		position: absolute;
		right: -2px;
		top: 50%;
		transform: translateY(-50%);
		font-size: 9px;
		line-height: 1;
		color: var(--color-danger);
	}
</style>
