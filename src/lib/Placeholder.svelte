<script lang="ts">
	let {
		eyebrow,
		title,
		phase,
		note
	}: { eyebrow: string; title: string; phase?: 2 | 3; note?: string } = $props();
</script>

<header class="page-head">
	<span class="eyebrow">{eyebrow}</span>
	<h1>{title}</h1>
</header>

<section class="surface" style="padding: var(--space-8); text-align: center;">
	{#if phase}
		<span class="chip" data-tone="info">Coming in Phase {phase}</span>
		<p class="t-body-sm t-muted" style="margin-top: var(--space-4);">
			This surface is planned and stubbed — see PLAN.md.
		</p>
	{:else}
		<p class="t-body-sm t-muted">{note ?? 'Nothing here yet.'}</p>
	{/if}
</section>
