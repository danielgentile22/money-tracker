<script lang="ts">
	// Actual-vs-target bar: success under target, warning near it, danger over.
	let {
		value,
		max,
		label = ''
	}: { value: number; max: number; label?: string } = $props();

	const frac = $derived(max > 0 ? value / max : 0);
	const tone = $derived(frac > 1 ? 'danger' : frac >= 0.85 ? 'warning' : 'success');
</script>

<div
	class="progress"
	role="progressbar"
	aria-valuenow={value}
	aria-valuemin={0}
	aria-valuemax={max}
	aria-label={label}
>
	<div class="fill" data-tone={tone} style="width: {Math.min(frac, 1) * 100}%;"></div>
</div>

<style>
	.progress {
		height: 6px;
		border-radius: var(--radius-full);
		background-color: var(--color-elevated);
		overflow: hidden;
	}
	.fill {
		height: 100%;
		border-radius: var(--radius-full);
		background-color: var(--color-success);
		transition: width var(--motion-base) var(--easing-standard);
	}
	.fill[data-tone='warning'] {
		background-color: var(--color-warning);
	}
	.fill[data-tone='danger'] {
		background-color: var(--color-danger);
	}
</style>
