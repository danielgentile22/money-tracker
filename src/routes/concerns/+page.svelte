<script lang="ts">
	import Sparkline from '$lib/charts/Sparkline.svelte';

	let { data } = $props();

	const tone = { low: 'info', medium: 'warning', high: 'danger' } as const;
</script>

<header class="page-head">
	<span class="eyebrow">Attention</span>
	<h1>Concerns</h1>
</header>

{#if data.warming.length > 0}
	<section
		class="surface"
		style="padding: var(--space-4) var(--space-5); margin-bottom: var(--space-4); border-color: var(--color-info);"
	>
		<p class="t-body-sm">
			<strong>{data.warming.length} Detector{data.warming.length === 1 ? '' : 's'} still warming
				up</strong>
			— {data.warming.map((w) => w.label).join(', ')}
			need{data.warming.length === 1 ? 's' : ''}
			{data.warming[0].needMonths} full months of history ({data.fullMonths} collected). Quiet here
			doesn't mean all clear yet.
		</p>
	</section>
{/if}

{#if data.concerns.length === 0}
	<section class="surface" style="padding: var(--space-8); text-align: center;">
		<p class="t-body-sm t-muted">
			No active Concerns. Detectors run after every sync — new ones land here ranked by severity.
		</p>
	</section>
{:else}
	<ul class="feed">
		{#each data.concerns as c (c.id)}
			<li class="surface item" id="concern-{c.id}">
				<span class="chip" data-tone={tone[c.bucket]}>{c.bucket} · {c.severity}</span>
				<span class="title-block">
					<a class="title t-body" href={c.link} title="open backing Transactions">{c.title}</a>
					{#if c.narration}
						<span class="t-body-sm t-muted narration">{c.narration}</span>
					{/if}
				</span>
				<Sparkline values={c.spark} />
				<span class="t-body-sm t-muted">{c.detector}</span>
				<form method="POST" action="?/dismiss">
					<input type="hidden" name="id" value={c.id} />
					<button class="btn btn-tertiary btn-sm" title="hide unless it materially worsens">
						Dismiss
					</button>
				</form>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.feed {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	.item {
		display: grid;
		grid-template-columns: auto 1fr auto auto auto;
		align-items: center;
		gap: var(--space-4);
		padding: var(--space-4) var(--space-5);
	}
	/* Sparkline sizing outside a stat-tile (Halo scopes .stat-spark to tiles) */
	.item :global(.stat-spark) {
		width: 96px;
		height: 32px;
		color: var(--color-primary);
	}
	.title-block {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		flex: 1;
	}
	.narration {
		font-style: italic;
	}
	.title {
		text-decoration: none;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.title:hover {
		text-decoration: underline;
	}
</style>
