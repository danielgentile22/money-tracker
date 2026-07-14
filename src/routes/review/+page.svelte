<script lang="ts">
	import { onMount } from 'svelte';
	import { fmtUSD } from '$lib/money';
	import { Check, X } from '@lucide/svelte';

	let { data } = $props();

	// p3-04: keyboard-driven review. Keys act on the open queue only — the
	// rejected list below stays pointer-driven, so a mis-keyed R is recoverable.
	let focused = $state(-1);
	let cards: HTMLElement[] = $state([]);

	onMount(() => {
		if (data.items.length === 0) return;
		// an action reloads the page; the next item slides into the stored
		// index, so restoring it advances focus for free
		const saved = Number(sessionStorage.getItem('review-focus') ?? '0');
		sessionStorage.removeItem('review-focus');
		focused = Number.isFinite(saved) ? Math.min(Math.max(saved, 0), data.items.length - 1) : 0;
	});

	function onKeydown(e: KeyboardEvent) {
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		const target = e.target as HTMLElement | null;
		// inert while typing or while any dialog (incl. the ⌘K palette) is up
		if (target?.closest('input, textarea, select, dialog, [role="dialog"]')) return;
		if (data.items.length === 0) return;
		switch (e.key.toLowerCase()) {
			case 'j':
				focused = Math.min(focused + 1, data.items.length - 1);
				e.preventDefault();
				break;
			case 'k':
				focused = Math.max(focused - 1, 0);
				e.preventDefault();
				break;
			case 'a':
			case 'r': {
				const btn = cards[focused]?.querySelector<HTMLButtonElement>(
					e.key.toLowerCase() === 'a' ? '[data-kb="approve"]' : '[data-kb="reject"]'
				);
				if (btn) {
					sessionStorage.setItem('review-focus', String(focused));
					btn.click(); // native submit — carries the card's toggle state with it
					e.preventDefault();
				}
				break;
			}
		}
	}

	$effect(() => {
		cards[focused]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
	});
</script>

<svelte:window onkeydown={onKeydown} />

<header class="page-head">
	<span class="eyebrow">Queue</span>
	<h1>Review queue</h1>
</header>

{#if data.items.length === 0}
	<section class="surface" style="padding: var(--space-8); text-align: center;">
		<p class="t-body-sm t-muted">Nothing waiting for review.</p>
	</section>
{:else}
	<p class="t-body-sm t-muted kbd-hint">
		<kbd>J</kbd>/<kbd>K</kbd> move · <kbd>A</kbd> approve (top pairing / lone leg =
		saved) · <kbd>R</kbd> reject — an R'd item drops to the reopenable list below
	</p>
	<div class="stack stack-md">
		{#each data.items as item, i (item.id)}
			<section
				class="surface"
				class:kb-focused={i === focused}
				bind:this={cards[i]}
				style="padding: var(--space-5);"
			>
				<div class="row" style="gap: var(--space-2); margin-bottom: var(--space-3);">
					<span class="chip" data-tone="info">Transfer?</span>
					{#if item.isLoneLeg}
						<span class="t-body-sm t-muted">Plaid flagged this leg; no partner found</span>
					{:else if item.candidates.length > 1}
						<span class="t-body-sm t-muted">{item.candidates.length} possible partners</span>
					{/if}
				</div>

				{#if item.txn}
					<div class="row-between evidence">
						<span>
							<span class="t-mono-sm t-muted">{item.txn.date}</span>
							{item.txn.merchant ?? item.txn.name}
							<span class="t-body-sm t-muted">· {item.txn.account_name}</span>
						</span>
						<span class="t-mono-sm" class:neg={item.txn.amount_cents < 0} class:pos={item.txn.amount_cents > 0}>
							{fmtUSD(item.txn.amount_cents)}
						</span>
					</div>
				{/if}

				{#each item.candidates as c (c.id)}
					<div class="row-between evidence candidate">
						<span>
							<span class="t-mono-sm t-muted">{c.date}</span>
							{c.merchant ?? c.name}
							<span class="t-body-sm t-muted">· {c.account_name}</span>
						</span>
						<span class="row" style="gap: var(--space-3);">
							<span class="t-mono-sm" class:neg={c.amount_cents < 0} class:pos={c.amount_cents > 0}>
								{fmtUSD(c.amount_cents)}
							</span>
							<form method="POST" action="?/approve">
								<input type="hidden" name="id" value={item.id} />
								<input type="hidden" name="candidate_id" value={c.id} />
								<button class="btn btn-secondary btn-sm" type="submit" title="Confirm this pairing" data-kb="approve">
									<Check /> Pair
								</button>
							</form>
						</span>
					</div>
				{/each}

				<div class="row" style="justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-3);">
					{#if item.isLoneLeg}
						<!-- one-sided Transfer: the partner leg is at an institution that
						     sends no transactions (e.g. the 529s) -->
						<form method="POST" action="?/approveLone">
							<input type="hidden" name="id" value={item.id} />
							<input type="hidden" name="saved" value="1" />
							<button class="btn btn-secondary btn-sm" type="submit"
								title="Contribution into savings/investment/529 — counts as saved"
								data-kb="approve">
								<Check /> Transfer — saved
							</button>
						</form>
						<form method="POST" action="?/approveLone">
							<input type="hidden" name="id" value={item.id} />
							<input type="hidden" name="saved" value="0" />
							<button class="btn btn-secondary btn-sm" type="submit"
								title="Internal move, not a contribution (e.g. paying a card elsewhere)">
								<Check /> Transfer only
							</button>
						</form>
					{/if}
					<form method="POST" action="?/reject">
						<input type="hidden" name="id" value={item.id} />
						<button class="btn btn-tertiary btn-sm" type="submit" data-kb="reject">
							<X /> Not a Transfer
						</button>
					</form>
				</div>
			</section>
		{/each}
	</div>
{/if}

{#if data.rejected.length > 0}
	<details class="surface" style="padding: var(--space-4) var(--space-5); margin-top: var(--space-4);">
		<summary class="t-body-sm t-muted" style="cursor: pointer;">
			{data.rejected.length} rejected item{data.rejected.length === 1 ? '' : 's'} — reopen any for a
			fresh verdict
		</summary>
		<ul style="margin-top: var(--space-3);">
			{#each data.rejected as r (r.id)}
				<li class="row-between evidence">
					<span>
						{#if r.txn}
							<span class="t-mono-sm t-muted">{r.txn.date}</span>
							{r.txn.merchant ?? r.txn.name}
							<span class="t-body-sm t-muted">· {r.txn.account_name}</span>
						{:else}
							<span class="t-body-sm t-muted">Transaction no longer exists</span>
						{/if}
					</span>
					<span class="row" style="gap: var(--space-3);">
						{#if r.txn}
							<span class="t-mono-sm" class:neg={r.txn.amount_cents < 0} class:pos={r.txn.amount_cents > 0}>
								{fmtUSD(r.txn.amount_cents)}
							</span>
						{/if}
						<form method="POST" action="?/reopen">
							<input type="hidden" name="id" value={r.id} />
							<button class="btn btn-tertiary btn-sm" type="submit">Reopen</button>
						</form>
					</span>
				</li>
			{/each}
		</ul>
	</details>
{/if}

<style>
	.evidence {
		padding: var(--space-2) 0;
		border-top: var(--border-width) solid var(--color-border);
	}
	.candidate {
		padding-left: var(--space-5);
	}
	.kb-focused {
		box-shadow: var(--focus-ring);
	}
	.kbd-hint {
		margin-bottom: var(--space-3);
	}
	kbd {
		font-family: var(--font-mono);
		font-size: 0.85em;
		padding: 1px 5px;
		border: var(--border-width) solid var(--color-border);
		border-radius: var(--radius-sm);
		background: var(--color-elevated);
	}
	.pos {
		color: var(--color-success);
	}
	.neg {
		color: var(--color-danger);
	}
</style>
