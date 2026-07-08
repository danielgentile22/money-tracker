<script lang="ts">
	import type { Snapshot, WidgetSize } from '$lib/server/dashboard';

	let { data, size = 'medium' }: { data: NonNullable<Snapshot['concerns']>; size?: WidgetSize } =
		$props();

	const concernTone = { low: 'info', medium: 'warning', high: 'danger' } as const;
</script>

<div class="row-between" style="margin-bottom: var(--space-3);">
	<span class="eyebrow">Top Concerns</span>
	{#if size !== 'small'}
		<!-- story 12: the widget's "view all" is how the Concerns page is reached -->
		<a class="btn btn-tertiary btn-sm" href="/concerns">
			View all{data.total > 0 ? ` (${data.total})` : ''} →
		</a>
	{/if}
</div>

{#if size === 'small'}
	<!-- small tile: the count and the worst offender; tap for the rest -->
	<a href="/concerns" class="small-tile">
		<span class="stat-value">{data.total}</span>
		<span class="t-body-sm t-muted small-top">
			{data.top.length > 0 ? data.top[0].title : 'No active Concerns at last sync.'}
		</span>
	</a>
{:else if data.top.length === 0}
	<p class="t-body-sm t-muted">No active Concerns at last sync.</p>
{:else}
	<ul class="concern-list">
		{#each data.top as c (c.id)}
			<li>
				<a class="concern-row" href="/concerns#concern-{c.id}">
					<span class="chip" data-tone={concernTone[c.bucket]}>{c.severity}</span>
					<span class="concern-text">
						<span class="t-body-sm concern-title">{c.title}</span>
						{#if c.narration}
							<span class="t-body-sm t-muted concern-narration">{c.narration}</span>
						{/if}
					</span>
				</a>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.small-tile {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		text-decoration: none;
	}
	.small-top {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.concern-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.concern-row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		text-decoration: none;
	}
	.concern-row:hover .concern-title {
		text-decoration: underline;
	}
	.concern-text {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.concern-title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.concern-narration {
		font-style: italic;
	}
</style>
