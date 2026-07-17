<script lang="ts">
	import { goto } from '$app/navigation';
	import { fmtUSD } from '$lib/money';
	import { Search, CornerDownRight } from '@lucide/svelte';

	type Result = {
		id: number;
		date: string;
		merchant: string | null;
		name: string;
		amount_cents: number;
		account_name: string;
		category_name: string | null;
	};

	let { splitLabel = 'Splits' } = $props();

	// Session 4: every page stays keyboard-reachable, including folded-in ones
	const pages = $derived([
		{ href: '/', label: 'Dashboard' },
		{ href: '/transactions', label: 'Transactions' },
		{ href: '/categories', label: 'Categories' },
		{ href: '/recurring', label: 'Recurring' },
		{ href: '/splits', label: splitLabel },
		{ href: '/reports', label: 'Reports' },
		{ href: '/accounts', label: 'Accounts' },
		{ href: '/settings', label: 'Settings' },
		{ href: '/review', label: 'Review queue' },
		{ href: '/projections', label: 'Projections' },
		{ href: '/concerns', label: 'Concerns' },
		{ href: '/rules', label: 'Rules' }
	]);

	let open = $state(false);
	let query = $state('');
	let results = $state<Result[]>([]);
	let selected = $state(0);
	let inputEl: HTMLInputElement | undefined = $state();
	let timer: ReturnType<typeof setTimeout> | undefined;

	// pages list first, transaction results after — one selection index across both
	const pageMatches = $derived(
		query.trim()
			? pages.filter((p) => p.label.toLowerCase().includes(query.trim().toLowerCase()))
			: pages
	);
	const total = $derived(pageMatches.length + results.length);

	function onKeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
			e.preventDefault();
			open = !open;
			if (open) setTimeout(() => inputEl?.focus(), 0);
		} else if (e.key === 'Escape' && open) {
			close();
		}
	}

	let reqId = 0; // monotonic token: only the latest in-flight search may land

	function close() {
		clearTimeout(timer);
		reqId++; // orphan any in-flight fetch so it can't repopulate results after close
		open = false;
		query = '';
		results = [];
		selected = 0;
	}

	function onInput() {
		selected = 0; // pageMatches shrinks immediately; don't leave the highlight past the end
		clearTimeout(timer);
		timer = setTimeout(async () => {
			if (!query.trim()) {
				results = [];
				return;
			}
			const id = ++reqId;
			try {
				const res = await fetch(`/search?q=${encodeURIComponent(query)}`);
				if (!res.ok || id !== reqId || !open) return;
				results = (await res.json()).results;
			} catch {
				/* transient — keep whatever is shown, next keystroke retries */
			}
		}, 150);
	}

	function pick(r: Result) {
		close();
		goto(`/transactions?focus=${r.id}`);
	}

	function pickPage(p: { href: string }) {
		close();
		goto(p.href);
	}

	function onListKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			selected = Math.min(selected + 1, total - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			selected = Math.max(selected - 1, 0);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			if (selected < pageMatches.length) {
				if (pageMatches[selected]) pickPage(pageMatches[selected]);
			} else if (results[selected - pageMatches.length]) {
				pick(results[selected - pageMatches.length]);
			}
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
	<div
		class="palette-backdrop"
		onclick={(e) => e.target === e.currentTarget && close()}
		role="presentation"
	>
		<div class="palette" role="dialog" aria-label="Search Transactions" tabindex="-1">
			<div class="palette-input row">
				<Search />
				<input
					bind:this={inputEl}
					bind:value={query}
					oninput={onInput}
					onkeydown={onListKeydown}
					type="text"
					placeholder="Search Merchant, amount (63.47), or Category…"
					aria-label="Search"
				/>
				<kbd class="t-mono-sm t-muted">esc</kbd>
			</div>
			{#if total > 0}
				<ul class="palette-results" role="listbox">
					{#each pageMatches as p, i (p.href)}
						<li role="option" aria-selected={i === selected}>
							<button class:active={i === selected} onclick={() => pickPage(p)}>
								<CornerDownRight />
								<span class="grow">{p.label}</span>
								<span class="t-mono-sm t-muted">page</span>
							</button>
						</li>
					{/each}
					{#each results as r, i (r.id)}
						{@const idx = pageMatches.length + i}
						<li role="option" aria-selected={idx === selected}>
							<button class:active={idx === selected} onclick={() => pick(r)}>
								<span class="t-mono-sm t-muted">{r.date}</span>
								<span class="grow">{r.merchant ?? r.name}</span>
								{#if r.category_name}<span class="chip">{r.category_name}</span>{/if}
								<span class="t-mono-sm">{fmtUSD(r.amount_cents)}</span>
							</button>
						</li>
					{/each}
				</ul>
			{:else if query.trim()}
				<p class="t-body-sm t-muted" style="padding: var(--space-4);">No matches.</p>
			{/if}
		</div>
	</div>
{/if}

<style>
	.palette-backdrop {
		position: fixed;
		inset: 0;
		background-color: rgba(10, 11, 15, 0.72);
		z-index: 100;
		display: flex;
		justify-content: center;
		align-items: flex-start;
		padding-top: 14vh;
	}

	.palette {
		width: min(640px, 92vw);
		background-color: var(--color-elevated);
		border: var(--border-width) solid var(--color-border-strong);
		border-radius: var(--radius-lg);
		box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
		overflow: hidden;
	}

	.palette-input {
		gap: var(--space-3);
		padding: var(--space-4);
		border-bottom: var(--border-width) solid var(--color-border);
		color: var(--color-text-muted);
	}

	.palette-input input {
		flex: 1;
		background: none;
		border: none;
		outline: none;
		color: var(--color-text-primary);
		font-family: var(--font-body);
		font-size: var(--text-body-md-size);
	}

	.palette-results {
		max-height: 320px;
		overflow-y: auto;
	}

	.palette-results button {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		width: 100%;
		padding: var(--space-3) var(--space-4);
		background: none;
		border: none;
		color: var(--color-text-primary);
		font-family: var(--font-body);
		font-size: var(--text-body-sm-size);
		cursor: pointer;
		text-align: left;
	}

	.palette-results button.active,
	.palette-results button:hover {
		background-color: var(--color-primary-soft);
	}

	.palette-results button :global(svg) {
		width: 14px;
		height: 14px;
		flex-shrink: 0;
		color: var(--color-text-muted);
	}

	.palette-results .grow {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
