<script lang="ts">
	import LineChart from './charts/LineChart.svelte';

	type Point = { date: string; balance_cents: number; estimated: number };

	let { series, height = 140 }: { series: Point[]; height?: number } = $props();

	const points = $derived(
		series.map((p) => ({ date: p.date, value_cents: p.balance_cents, estimated: p.estimated }))
	);
</script>

<LineChart series={points} {height} />
