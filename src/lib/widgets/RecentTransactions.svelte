<script lang="ts">
	import { fmtUSD } from '$lib/money';
	import type { Snapshot } from '$lib/server/dashboard';

	let { data }: { data: NonNullable<Snapshot['recent-transactions']> } = $props();
</script>

<div class="row-between" style="margin-bottom: var(--space-3);">
	<span class="eyebrow">Recent transactions</span>
	<a class="btn btn-tertiary btn-sm" href="/transactions">Transactions →</a>
</div>

{#if data.rows.length === 0}
	<p class="t-body-sm t-muted">Nothing synced yet.</p>
{:else}
	<ul class="txns">
		{#each data.rows as r (r.id)}
			<li>
				<a class="txn-row" href="/transactions?focus={r.id}">
					<span class="t-mono-sm t-muted">{r.date.slice(5)}</span>
					<span class="t-body-sm txn-name">{r.merchant ?? r.name}</span>
					{#if r.category_name}<span class="chip">{r.category_name}</span>{/if}
					<span class="t-mono-sm amt">{fmtUSD(r.amount_cents)}</span>
				</a>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.txns {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.txn-row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		text-decoration: none;
	}
	.txn-row:hover .txn-name {
		text-decoration: underline;
	}
	.txn-name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.amt {
		text-align: right;
	}
</style>
