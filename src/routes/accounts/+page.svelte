<script lang="ts">
	import LinkButton from '$lib/LinkButton.svelte';
	import BalanceChart from '$lib/BalanceChart.svelte';
	import { fmtUSD } from '$lib/money';
	import { invalidateAll } from '$app/navigation';

	let { data } = $props();

	const tone = { healthy: 'success', degraded: 'warning', broken: 'danger' } as const;

	async function remove(connectionId: number, name: string) {
		if (!confirm(`Remove ${name}? This revokes the Plaid Item and deletes its Accounts, Transactions, and Snapshots locally.`))
			return;
		await fetch('/accounts/remove', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ connectionId })
		});
		await invalidateAll();
	}
</script>

<header class="page-head row-between">
	<div>
		<span class="eyebrow">Holdings</span>
		<h1>Accounts</h1>
	</div>
	{#if data.plaidReady}
		<LinkButton />
	{/if}
</header>

{#if !data.plaidReady}
	<section
		class="surface"
		style="padding: var(--space-5); margin-bottom: var(--space-4); border-color: var(--color-warning);"
	>
		<p class="t-body-sm">
			<strong>Plaid keys missing from the Keychain</strong> ({data.plaidEnv} environment). Add them,
			then reload:
		</p>
		<pre
			class="t-mono-sm t-muted"
			style="margin-top: var(--space-3); overflow-x: auto;">security add-generic-password -s money-tracker -a plaid-client-id -w &lt;client_id&gt;
security add-generic-password -s money-tracker -a plaid-secret-{data.plaidEnv} -w &lt;secret&gt;</pre>
	</section>
{/if}

{#if data.connections.length === 0}
	<section class="surface" style="padding: var(--space-8); text-align: center;">
		<p class="t-body-sm t-muted">
			No Connections yet.
			{#if data.plaidReady}Link an institution with “Add Connection”.{/if}
		</p>
	</section>
{:else}
	{#each data.connections as connection (connection.id)}
		<section class="surface" style="padding: var(--space-5); margin-bottom: var(--space-4);">
			<div class="row-between" style="margin-bottom: var(--space-4);">
				<div class="row" style="gap: var(--space-3);">
					<h2 class="t-title-md">{connection.institution_name}</h2>
					<span class="chip" data-tone={tone[connection.health]}>{connection.health}</span>
				</div>
				<span class="row" style="gap: var(--space-2);">
					{#if connection.health === 'broken'}
						<LinkButton connectionId={connection.id} label="Re-link" variant="btn-secondary" />
					{/if}
					<button
						class="btn btn-tertiary btn-sm"
						onclick={() => remove(connection.id, connection.institution_name)}
					>
						Remove
					</button>
				</span>
			</div>
			{#if connection.health !== 'healthy' && connection.last_sync_error}
				<p class="t-body-sm" style="color: var(--color-warning); margin-bottom: var(--space-3);">
					{connection.last_sync_error}
				</p>
			{/if}
			<ul style="display: flex; flex-direction: column;">
				{#each data.accounts.filter((a) => a.connection_id === connection.id) as account (account.id)}
					<li
						class="row-between"
						style="padding: var(--space-3) 0; border-top: var(--border-width) solid var(--color-border);"
					>
						<span>
							{account.name}
							<span class="t-body-sm t-muted" style="margin-left: var(--space-2);">
								{account.subtype ?? account.type}{account.mask ? ` ····${account.mask}` : ''}
							</span>
						</span>
						<span class="t-mono-sm">{fmtUSD(account.current_balance_cents)}</span>
					</li>
					{#if (data.series[account.id]?.length ?? 0) > 1}
						<li style="padding: var(--space-2) 0 var(--space-3);">
							<BalanceChart series={data.series[account.id]} />
						</li>
					{/if}
				{/each}
			</ul>
		</section>
	{/each}
{/if}
