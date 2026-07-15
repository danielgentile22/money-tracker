<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import FilterBar from '$lib/FilterBar.svelte';
	import Ledger from '$lib/Ledger.svelte';
	import ScanConfirm from '$lib/ScanConfirm.svelte';
	import { MailSearch } from '@lucide/svelte';

	// every Gmail/AI button confirms first: what, how many, time, cost
	let scanConfirm: ScanConfirm | undefined = $state();
	const confirmScan = (e: SubmitEvent, intro: string, search: number) =>
		scanConfirm?.ask(e, intro, { categorize: 0, search });

	let { data, form } = $props();

	function applyAmounts(form: HTMLFormElement) {
		const d = new FormData(form);
		const q = new URLSearchParams(page.url.searchParams);
		q.delete('page');
		for (const k of ['min', 'max'] as const) {
			const v = String(d.get(k) ?? '').trim();
			if (v) q.set(k, v);
			else q.delete(k);
		}
		goto(`?${q}`, { keepFocus: true, noScroll: true });
	}
</script>

<header class="page-head">
	<span class="eyebrow">Ledger</span>
	<div class="row-between" style="flex-wrap: wrap; gap: var(--space-3);">
		<h1>Transactions</h1>
		<!-- Session 4 fold-in: daily triage, one click from its section -->
		<a class="btn btn-secondary btn-sm" href="/review">
			Review queue
			<span class="chip" data-tone={data.openReview > 0 ? 'warning' : 'neutral'}>
				{data.openReview}
			</span>
		</a>
	</div>
</header>

{#if form?.message}
	<div class="sync-banner" role="alert"><p class="t-body-sm">{form.message}</p></div>
{:else if form?.started != null}
	<div class="sync-banner" role="status">
		<p class="t-body-sm">
			Receipt search started on {form.started} charge{form.started === 1 ? '' : 's'} — runs in
			the background; progress shows under Settings → Scans.
		</p>
	</div>
{:else if form?.lookup}
	<div class="sync-banner" role="status">
		<p class="t-body-sm">
			Receipt lookup: {form.lookup === 'matched'
				? 'match found — details extracted and the Category re-judged'
				: form.lookup === 'retained'
					? 'no newer match — existing receipt kept'
					: form.lookup === 'pending'
						? 'nothing yet — will retry on coming syncs'
						: 'no receipt found'}
		</p>
	</div>
{/if}

<!-- Session 3: the ledger runs on the shared filter engine — same vocabulary
     as Reports and Cash Flow. Amount bounds stay page-local. -->
<FilterBar
	tree={data.filterTree}
	accounts={data.accounts}
	tags={data.allTags}
	merchants={data.merchants}
	saved={data.saved}
/>

<form class="row filters" onsubmit={(e) => { e.preventDefault(); applyAmounts(e.currentTarget as HTMLFormElement); }}>
	<label class="field">
		<span class="field-label">Min $</span>
		<input class="input amt" type="number" step="0.01" min="0" name="min" value={data.amounts.min ?? ''} />
	</label>
	<label class="field">
		<span class="field-label">Max $</span>
		<input class="input amt" type="number" step="0.01" min="0" name="max" value={data.amounts.max ?? ''} />
	</label>
	<button class="btn btn-secondary btn-sm" type="submit">Apply</button>
	<a class="btn btn-tertiary btn-sm" href="/transactions/export?{page.url.searchParams}" download>
		Export CSV
	</a>
</form>

<ScanConfirm bind:this={scanConfirm} />

<!-- bulk receipt search: every filtered spend charge, not just this page -->
<form
	method="POST"
	action="?/lookupAll"
	class="row"
	style="margin-bottom: var(--space-4);"
	onsubmit={(e) =>
		confirmScan(
			e,
			`Search enrolled Inboxes for receipts on all ${data.lookupCount} filtered charges?`,
			data.lookupCount
		)}
>
	<input type="hidden" name="qs" value={page.url.search} />
	<button
		class="btn btn-tertiary btn-sm"
		type="submit"
		disabled={data.lookupCount === 0 || data.scanning}
		title="Search enrolled Inboxes for a receipt on every charge matching the current filters"
	>
		<MailSearch />
		{data.scanning ? 'A scan is already running…' : `Search receipts (${data.lookupCount} charges)`}
	</button>
</form>

{#if data.rows.length === 0}
	<section class="surface" style="padding: var(--space-8); text-align: center;">
		<p class="t-body-sm t-muted">
			No Transactions{data.hasDimensionFilters || data.amounts.min || data.amounts.max
				? ' match these filters'
				: ' yet — link a Connection on the Accounts surface'}.
		</p>
	</section>
{:else}
	<Ledger
		rows={data.rows}
		page={data.page}
		hasMore={data.hasMore}
		focus={data.focus}
		tree={data.tree}
		allTags={data.allTags}
	/>
{/if}
