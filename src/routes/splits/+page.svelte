<script lang="ts">
	import { fmtUSD } from '$lib/money';
	import { RefreshCw, Trash2, Link2 } from '@lucide/svelte';
	import type { PeriodView } from '$lib/server/split-usage';

	let { data, form } = $props();

	const fmtDay = (iso: string) =>
		new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		});

	const sharePctOf = (p: PeriodView) =>
		p.totalCost > 0 ? `${((p.matchedCost / p.totalCost) * 100).toFixed(1)}%` : '—';

	// newest first: the open (live) period sits on top
	const rows = (views: PeriodView[]) => [...views].reverse();

	const today = new Date().toLocaleDateString('en-CA'); // local yyyy-mm-dd, not UTC
</script>

<svelte:head><title>{data.displayName} — Money Tracker</title></svelte:head>

<header class="page-head">
	<span class="eyebrow">{data.displayName}</span>
	<h1>{data.displayName}</h1>
</header>

{#if form?.message}
	<div class="sync-banner" role="alert"><p class="t-body-sm">{form.message}</p></div>
{/if}
{#if data.usageError}
	<div class="sync-banner" role="alert">
		<p class="t-body-sm">usage data unavailable — {data.usageError}</p>
	</div>
{/if}

<section class="surface headline">
	<span class="eyebrow">{data.partnerName} owes</span>
	<p class="owed">{fmtUSD(data.summary.outstandingCents)}</p>
	<p class="t-body-sm t-muted">
		{data.sharePct}% of {fmtUSD(data.summary.attributableCents)} attributable (of
		{fmtUSD(data.summary.chargedCents)} charged across closed periods) = {fmtUSD(
			data.summary.owedCents
		)} owed − {fmtUSD(data.summary.paidCents)} repaid. The live period joins once its next charge
		closes it.
	</p>
</section>

{#each Object.entries(data.periods) as [provider, views] (provider)}
	<section class="surface block">
		<h2 class="t-body-sm eyebrow">{provider} periods</h2>
		{#if views.length === 0}
			<p class="t-body-sm t-muted">No computed periods — check the banner above or recompute.</p>
		{:else}
			<table>
				<thead>
					<tr>
						<th>Period</th>
						<th>Status</th>
						<th class="num">Charge</th>
						<th class="num">Share</th>
						<th class="num">Attributable</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					{#each rows(views) as p (p.chargeId)}
						<tr>
							<td>{fmtDay(p.from)} → {p.to ? fmtDay(p.to) : 'now'}</td>
							<td>
								{#if p.to === null}
									<span class="chip" data-tone="info">live</span>
								{:else}
									<span class="chip" data-tone="neutral">frozen</span>
								{/if}
							</td>
							<td class="num">{fmtUSD(p.amountCents)}</td>
							<td class="num">{sharePctOf(p)}</td>
							<td class="num">{fmtUSD(p.attributableCents)}</td>
							<td class="actions">
								<form method="POST" action="?/recompute">
									<input type="hidden" name="id" value={p.chargeId} />
									<button class="btn btn-tertiary btn-sm btn-icon" title="Recompute this period">
										<RefreshCw />
									</button>
								</form>
								<form method="POST" action="?/deleteCharge">
									<input type="hidden" name="id" value={p.chargeId} />
									<button class="btn btn-tertiary btn-sm btn-icon" title="Delete this charge">
										<Trash2 />
									</button>
								</form>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</section>
{/each}

<section class="surface block">
	<h2 class="t-body-sm eyebrow">Add charge</h2>
	<form method="POST" action="?/addCharge" class="inline-form">
		<select name="provider" aria-label="Provider">
			{#each data.providers as p (p.id)}
				<option value={p.id}>{p.id}</option>
			{/each}
		</select>
		<input type="date" name="date" required max={today} aria-label="Charge date" />
		<input type="text" name="amount" required placeholder="0.00" inputmode="decimal" aria-label="Amount ($)" />
		<input type="text" name="note" placeholder="note (optional)" aria-label="Note" />
		<button class="btn btn-secondary btn-sm">Add</button>
	</form>
	<p class="t-body-sm t-muted">
		A new charge closes the previous period at its date (end-exclusive) and freezes its result.
	</p>
</section>

<section class="surface block">
	<h2 class="t-body-sm eyebrow">Repayments from {data.partnerName}</h2>

	{#if data.proposals.length > 0}
		<div class="proposals">
			{#each data.proposals as t (t.id)}
				<form method="POST" action="?/linkPayment" class="proposal-row">
					<input type="hidden" name="transaction_id" value={t.id} />
					<span class="chip" data-tone="info">proposed match</span>
					<span>{fmtDay(t.date)} · {t.name}</span>
					<span class="num">{fmtUSD(t.amount_cents)}</span>
					<button class="btn btn-secondary btn-sm">Confirm as repayment</button>
				</form>
			{/each}
		</div>
	{/if}

	{#if data.payments.length === 0}
		<p class="t-body-sm t-muted">No repayments recorded yet.</p>
	{:else}
		<table>
			<tbody>
				{#each data.payments as p (p.id)}
					<tr>
						<td>{fmtDay(p.date)}</td>
						<td>
							{#if p.transaction_id}
								<Link2 size={12} aria-hidden="true" />
								{p.transaction_name}
							{:else}
								{p.note ?? 'manual entry'}
							{/if}
						</td>
						<td class="num">{fmtUSD(p.amount_cents)}</td>
						<td class="actions">
							<form method="POST" action="?/deletePayment">
								<input type="hidden" name="id" value={p.id} />
								<button class="btn btn-tertiary btn-sm btn-icon" title="Delete repayment">
									<Trash2 />
								</button>
							</form>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}

	<form method="POST" action="?/addPayment" class="inline-form">
		<input type="date" name="date" required max={today} aria-label="Payment date" />
		<input type="text" name="amount" required placeholder="0.00" inputmode="decimal" aria-label="Amount ($)" />
		<input type="text" name="note" placeholder="note (optional)" aria-label="Note" />
		<button class="btn btn-secondary btn-sm">Record repayment</button>
	</form>

	{#if data.incoming.length > 0}
		<form method="POST" action="?/linkPayment" class="inline-form">
			<select name="transaction_id" aria-label="Incoming transaction">
				{#each data.incoming as t (t.id)}
					<option value={t.id}>{t.date} · {t.name} · {fmtUSD(t.amount_cents)}</option>
				{/each}
			</select>
			<button class="btn btn-secondary btn-sm">Link as repayment</button>
		</form>
	{/if}
</section>

<details class="surface fold">
	<summary>Settings</summary>
	<form method="POST" action="?/saveSettings" class="settings-form">
		<label
			>Sidebar label
			<input type="text" name="display_name" value={data.displayName} /></label
		>
		<label
			>Partner name
			<input type="text" name="partner_name" value={data.partnerName} /></label
		>
		<label
			>Partner share %
			<input type="number" name="share_pct" min="1" max="100" step="0.5" value={data.sharePct} /></label
		>
		<label
			>Repayment payee pattern
			<input
				type="text"
				name="payment_pattern"
				value={data.paymentPattern}
				placeholder="matches incoming transaction names"
			/></label
		>
		{#each data.providers as p (p.id)}
			<label
				>{p.id} project pattern
				<input
					type="text"
					name="pattern_{p.id}"
					value={p.pattern}
					placeholder="substring of usage project paths"
				/></label
			>
		{/each}
		<p class="t-body-sm t-muted">
			Changing a project pattern discards that provider's stored results — every period recomputes
			on next load.
		</p>
		<button class="btn btn-secondary btn-sm">Save</button>
	</form>
</details>

<style>
	.headline {
		padding: var(--space-6);
		margin-bottom: var(--space-4);
	}
	.owed {
		font-size: var(--text-3xl, 2rem);
		font-weight: 600;
		margin: var(--space-1) 0;
		font-variant-numeric: tabular-nums;
	}
	.block {
		padding: var(--space-4);
		margin-bottom: var(--space-4);
	}
	.block h2 {
		margin-bottom: var(--space-3);
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--text-sm, 0.875rem);
	}
	th {
		text-align: left;
		color: var(--color-text-secondary);
		font-weight: 500;
		padding: var(--space-1) var(--space-2);
	}
	td {
		padding: var(--space-2);
		border-top: 1px solid var(--color-border);
	}
	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.actions {
		display: flex;
		gap: var(--space-1);
		justify-content: flex-end;
		border-top: none;
	}
	tr .actions {
		border-top: 1px solid var(--color-border);
	}
	.inline-form {
		display: flex;
		gap: var(--space-2);
		align-items: center;
		flex-wrap: wrap;
		margin-top: var(--space-3);
	}
	.proposals {
		margin-bottom: var(--space-3);
	}
	.proposal-row {
		display: flex;
		gap: var(--space-3);
		align-items: center;
		padding: var(--space-2);
		border: 1px dashed var(--color-border);
		border-radius: var(--radius-md, 8px);
		margin-bottom: var(--space-2);
	}
	.proposal-row .num {
		margin-left: auto;
	}
	.fold {
		padding: var(--space-2) var(--space-3);
	}
	.fold summary {
		cursor: pointer;
		color: var(--color-text-secondary);
		font-size: var(--text-sm, 0.875rem);
		padding: var(--space-2);
	}
	.settings-form {
		display: grid;
		grid-template-columns: repeat(2, minmax(180px, 320px));
		gap: var(--space-3);
		padding: var(--space-3);
	}
	.settings-form label {
		display: grid;
		gap: var(--space-1);
		font-size: var(--text-sm, 0.875rem);
		color: var(--color-text-secondary);
	}
	.settings-form p,
	.settings-form button {
		grid-column: 1 / -1;
		justify-self: start;
	}
</style>
