<script lang="ts">
	// Tiny trend line for stat tiles; stroke follows currentColor so Halo's
	// .stat-spark tone rules color it. Plain SVG — no Plot needed at this size.
	let { values }: { values: number[] } = $props();

	const W = 96;
	const H = 32;
	const PAD = 2;

	const points = $derived.by(() => {
		if (values.length < 2) return '';
		const min = Math.min(...values);
		const max = Math.max(...values);
		const span = max - min || 1;
		return values
			.map((v, i) => {
				const x = PAD + (i * (W - 2 * PAD)) / (values.length - 1);
				const y = H - PAD - ((v - min) / span) * (H - 2 * PAD);
				return `${x.toFixed(1)},${y.toFixed(1)}`;
			})
			.join(' ');
	});
</script>

{#if points}
	<svg class="stat-spark" viewBox="0 0 {W} {H}" preserveAspectRatio="none" aria-hidden="true">
		<polyline
			{points}
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
	</svg>
{/if}
