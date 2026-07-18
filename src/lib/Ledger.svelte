<script lang="ts">
	import { fmtUSD } from '$lib/money';
	import { page } from '$app/state';
	import { actionUrl as act } from '$lib/action-url';
	import ScanConfirm from '$lib/ScanConfirm.svelte';
	import { MailSearch, X, ExternalLink } from '@lucide/svelte';
	import type { LedgerRow } from '$lib/server/ledger';
	import type { TransactionDetail } from '$lib/server/transaction-detail';

	type Row = LedgerRow & { ambiguous: boolean; tags: { id: number; name: string }[] };
	type CatTree = {
		id: number;
		name: string;
		emoji: string | null;
		categories: { id: number; name: string; emoji: string | null }[];
	}[];

	let {
		rows,
		page: pageNum,
		hasMore,
		focus,
		tree,
		allTags
	}: {
		rows: Row[];
		page: number;
		hasMore: boolean;
		focus: number | null;
		tree: CatTree;
		allTags: { id: number; name: string }[];
	} = $props();

	// every Gmail/AI button confirms first: what, how many, time, cost
	let scanConfirm: ScanConfirm | undefined = $state();
	const confirmScan = (e: SubmitEvent, intro: string, search: number) =>
		scanConfirm?.ask(e, intro, { categorize: 0, search });

	const RECEIPT_CHIP: Record<string, { label: string; tone: string }> = {
		pending: { label: 'receipt: searching', tone: 'info' },
		matched: { label: 'receipt matched', tone: 'success' },
		exhausted: { label: 'no receipt found', tone: 'neutral' }
	};
	// the detail dialog spells the receipt trail out in words
	const RECEIPT_TRAIL: Record<string, string> = {
		'not-searched': 'not searched',
		pending: 'searching — retries on coming syncs',
		matched: 'receipt matched',
		exhausted: 'searched, no receipt found'
	};

	type ReceiptFacts = {
		description: string;
		vendor: string | null;
		items: { name: string; price_cents: number | null }[];
	};
	const factsOf = (row: Row): ReceiptFacts | null =>
		row.receipt_facts_json ? JSON.parse(row.receipt_facts_json) : null;

	let editing = $state<Row | null>(null);
	let detail = $state<TransactionDetail | null>(null);
	let dialogEl: HTMLDialogElement | undefined = $state();
	let selected = $state<number[]>([]);
	let bulkOpen = $state(false);
	let bulkDialogEl: HTMLDialogElement | undefined = $state();

	const selectedRows = $derived(rows.filter((r) => selected.includes(r.id)));

	// the row is pure display — clicking it opens the one place that mutates
	async function openRow(row: Row) {
		editing = row;
		detail = null;
		const res = await fetch(`/transactions/${row.id}/detail`);
		if (res.ok) detail = await res.json();
	}

	$effect(() => {
		if (editing && dialogEl && !dialogEl.open) dialogEl.showModal();
	});
	$effect(() => {
		if (bulkOpen && bulkDialogEl && !bulkDialogEl.open) bulkDialogEl.showModal();
	});

	function pageLink(n: number): string {
		const q = new URLSearchParams(page.url.searchParams);
		q.set('page', String(n));
		return `?${q}`;
	}

	function closeDialog() {
		dialogEl?.close();
		editing = null;
	}

	const label = (x: { emoji: string | null; name: string }) =>
		x.emoji ? `${x.emoji} ${x.name}` : x.name;

	const range = (r: { min_amount_cents: number | null; max_amount_cents: number | null }) =>
		r.min_amount_cents == null && r.max_amount_cents == null
			? 'any amount'
			: `${r.min_amount_cents != null ? fmtUSD(r.min_amount_cents) : '…'}–${r.max_amount_cents != null ? fmtUSD(r.max_amount_cents) : '…'}`;
</script>

<!-- Grouped Category picker (story 13) — same tree everywhere. -->
{#snippet catOptions(selectedId: number | null, selectedName: string | null)}
	{#each tree as g (g.id)}
		{#if g.categories.length > 0}
			<optgroup label={label(g)}>
				{#each g.categories as c (c.id)}
					<option value={c.id} selected={selectedId != null ? c.id === selectedId : c.name === selectedName}>
						{label(c)}
					</option>
				{/each}
			</optgroup>
		{/if}
	{/each}
{/snippet}

<!-- hidden ids for the bulk forms — one copy per form -->
{#snippet bulkIds()}
	{#each selected as id (id)}
		<input type="hidden" name="ids" value={id} />
	{/each}
{/snippet}

<!-- free text creates the Tag inline; the datalist offers existing ones -->
<datalist id="tag-names">
	{#each allTags as t (t.id)}
		<option value={t.name}></option>
	{/each}
</datalist>

<ScanConfirm bind:this={scanConfirm} />

<!-- selection is not mutation: checkboxes only feed the bulk dialog -->
<div class="row bulk-bar" class:active={selected.length > 0}>
	<span class="t-body-sm t-muted">{selected.length} selected</span>
	<button
		class="btn btn-secondary btn-sm"
		type="button"
		disabled={selected.length === 0}
		onclick={() => (bulkOpen = true)}
	>
		Bulk actions…
	</button>
	{#if selected.length > 0}
		<button class="btn btn-tertiary btn-sm" type="button" onclick={() => (selected = [])}>
			Clear
		</button>
	{/if}
</div>

<div class="surface ledger">
	<table>
		<thead>
			<tr>
				<th></th>
				<th>Date</th>
				<th>Merchant</th>
				<th>Category</th>
				<th>Tags</th>
				<th>Account</th>
				<th class="num">Amount</th>
			</tr>
		</thead>
		<tbody>
			{#each rows as row (row.id)}
				<!-- the whole row opens the detail dialog; nothing on it mutates -->
				<tr
					class="rowlink"
					class:pending={row.pending === 1}
					class:focused={row.id === focus}
					tabindex="0"
					onclick={() => openRow(row)}
					onkeydown={(e) => {
						if (e.key === 'Enter') openRow(row);
					}}
				>
					<td onclick={(e) => e.stopPropagation()}>
						<input
							type="checkbox"
							name="ids"
							value={row.id}
							bind:group={selected}
							title="Select for bulk actions"
						/>
					</td>
					<td class="t-mono-sm t-muted">{row.date}</td>
					<td>
						{row.merchant ?? row.name}
						{#if factsOf(row)}
							<!-- Layer-1 enrichment: what the Receipt says this charge was for -->
							<span class="t-body-sm t-muted" title="from the matched receipt email">
								· {factsOf(row)!.description}
							</span>
						{/if}
						{#if row.pending === 1}<span class="chip" data-tone="neutral">pending</span>{/if}
						{#if row.recurring_cadence}
							<span class="chip" data-tone="info" title="recurring series">
								{row.recurring_cadence} · {fmtUSD(row.recurring_typical_cents)}
							</span>
						{/if}
					</td>
					<td>
						{#if row.category_name}
							<span class="chip" title="source: {row.category_source}">{row.category_name}</span>
							<span class="t-body-sm t-muted src">{row.category_source}</span>
						{/if}
						{#if row.unresolved === 1}
							<span class="chip" data-tone="warning">unresolved</span>
						{/if}
						{#if row.unresolved === 1 && row.receipt_search_state && RECEIPT_CHIP[row.receipt_search_state]}
							{@const rc = RECEIPT_CHIP[row.receipt_search_state]}
							<span class="chip" data-tone={rc.tone}>{rc.label}</span>
						{/if}
						{#if row.is_transfer === 1}
							<span class="chip" data-tone="info">transfer</span>
						{/if}
						{#if row.is_excluded === 1}
							<span class="chip" data-tone="neutral" title="left out of totals, graphs, and budgets">
								excluded
							</span>
						{/if}
						{#if row.is_saved === 1}
							<span class="chip" data-tone="success">saved</span>
						{/if}
					</td>
					<td class="tags-cell">
						{#each row.tags as t (t.id)}
							<span class="chip">{t.name}</span>
						{/each}
					</td>
					<td class="t-body-sm t-muted">{row.account_name}</td>
					<td class="num t-mono-sm" class:pos={row.amount_cents > 0} class:neg={row.amount_cents < 0}>
						{fmtUSD(row.amount_cents)}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>
<nav class="row-between" style="margin-top: var(--space-4);">
	<span class="t-body-sm t-muted">Page {pageNum}</span>
	<span class="row" style="gap: var(--space-2);">
		{#if pageNum > 1}
			<a class="btn btn-secondary btn-sm" href={pageLink(pageNum - 1)}>Previous</a>
		{/if}
		{#if hasMore}
			<a class="btn btn-secondary btn-sm" href={pageLink(pageNum + 1)}>Next</a>
		{/if}
	</span>
</nav>

<!-- ————— Transaction detail: everything known, every mutation ————— -->
{#if editing}
	<dialog class="correction detail" bind:this={dialogEl} onclose={() => (editing = null)}>
		<div class="row-between" style="align-items: start;">
			<div>
				<h2 class="t-title-md">{editing.merchant ?? editing.name}</h2>
				<p class="t-body-sm t-muted">
					{editing.date} · {fmtUSD(editing.amount_cents)} · {editing.account_name}
					{#if editing.pending === 1}<span class="chip" data-tone="neutral">pending</span>{/if}
				</p>
				{#if detail && detail.rawName !== (editing.merchant ?? editing.name)}
					<p class="t-body-sm t-muted" title="the raw bank-statement string">
						as it appeared: <span class="t-mono-sm">{detail.rawName}</span>
					</p>
				{/if}
			</div>
			<button class="btn btn-tertiary btn-sm btn-icon" type="button" onclick={closeDialog} title="Close">
				<X />
			</button>
		</div>

		{#if detail?.transferPeer}
			<!-- a Transfer's useful detail is its other leg, not receipts or Rules -->
			<div class="section t-body-sm">
				<span class="chip" data-tone="info">transfer</span>
				paired with
				<a href="/transactions?focus={detail.transferPeer.id}">
					{detail.transferPeer.account_name} · {detail.transferPeer.date} · {fmtUSD(
						detail.transferPeer.amount_cents
					)}
				</a>
			</div>
		{/if}

		<form method="POST" action={act('toggleExclude')} class="section">
			<input type="hidden" name="id" value={editing.id} />
			<button class="btn btn-secondary btn-sm" type="submit">
				{editing.is_excluded === 1 ? 'Include in totals' : 'Exclude from totals'}
			</button>
			<p class="t-body-sm t-muted" style="margin-top: 0.35rem;">
				{editing.is_excluded === 1
					? 'Counted in totals, graphs, and budgets.'
					: 'Kept out of totals, graphs, and budgets. Still counts toward the Account balance.'}
			</p>
		</form>

		{#if detail?.recurring}
			<div class="section t-body-sm">
				<span class="chip" data-tone="info">recurring</span>
				{detail.recurring.cadence} · typically {fmtUSD(detail.recurring.typical_amount_cents)}
			</div>
		{/if}

		{#if detail?.receipt}
			{@const r = detail.receipt}
			<div class="section">
				<h3 class="t-label">Receipt</h3>
				{#if r.facts}
					<div class="receipt-facts t-body-sm">
						<p>
							{r.facts.description}
							{#if r.facts.vendor}<span class="t-muted">· {r.facts.vendor}</span>{/if}
						</p>
						{#if r.facts.items.length > 0}
							<ul>
								{#each r.facts.items as item (item.name)}
									<li class="row-between">
										<span>{item.name}</span>
										{#if item.price_cents != null}
											<span class="t-mono-sm t-muted">{fmtUSD(item.price_cents)}</span>
										{/if}
									</li>
								{/each}
							</ul>
						{/if}
					</div>
				{/if}
				{#if r.email}
					<p class="t-body-sm">
						{r.email.from} — “{r.email.subject}” · {r.email.date}
						<a href={r.email.gmailUrl} target="_blank" rel="noopener noreferrer">
							Open in Gmail <ExternalLink size={12} />
						</a>
					</p>
				{/if}
				<p class="t-body-sm t-muted">{RECEIPT_TRAIL[r.state]}</p>
				{#if r.state !== 'matched'}
					<form
						method="POST"
						action={act('lookup')}
						onsubmit={(e) =>
							confirmScan(e, "Search enrolled Inboxes for this charge's receipt?", 1)}
					>
						<input type="hidden" name="id" value={editing.id} />
						<button class="btn btn-tertiary btn-sm" type="submit">
							<MailSearch /> Search receipts
						</button>
					</form>
				{/if}
			</div>
		{/if}

		{#if detail?.rules}
			<div class="section">
				<h3 class="t-label">How this was categorized</h3>
				<p class="t-body-sm">
					{editing.category_name ?? 'uncategorized'}
					{#if editing.category_source}
						<span class="t-muted">· source: {editing.category_source}</span>
					{/if}
				</p>
				{#if detail.plaid.primary || detail.plaid.detailed}
					<p class="t-body-sm t-muted">
						Plaid said {detail.plaid.detailed ?? detail.plaid.primary}
						{#if detail.plaid.confidence}({detail.plaid.confidence} confidence){/if}
					</p>
				{/if}
				{#if detail.rules.matches.length > 0}
					<!-- always answers *now* — which Rule fired historically is never recorded -->
					<ul class="rules t-body-sm">
						{#each detail.rules.matches as m (m.id)}
							<li>
								{m.merchant} · {range(m)} → {m.category_name ?? 'tags only'}
								{#if m.id === detail.rules.winnerId}
									<span class="chip" data-tone="success">applies</span>
								{/if}
							</li>
						{/each}
					</ul>
				{:else}
					<p class="t-body-sm t-muted">No Rules match this Transaction today.</p>
				{/if}
				{#if detail.rules.drifted}
					<p class="t-body-sm t-muted">
						Categorized by a Rule that has since changed — no current Rule produces this Category.
					</p>
				{/if}
			</div>
		{/if}

		<div class="section">
			<h3 class="t-label">Tags</h3>
			<div class="row" style="flex-wrap: wrap; gap: var(--space-2);">
				{#each editing.tags as t (t.id)}
					<form method="POST" action={act('untag')} style="display: inline;">
						<input type="hidden" name="id" value={editing.id} />
						<input type="hidden" name="tag_id" value={t.id} />
						<button class="chip chip-btn" type="submit" title="Remove Tag “{t.name}”">
							{t.name} <X size={11} />
						</button>
					</form>
				{/each}
				<form method="POST" action={act('tag')} style="display: inline;">
					<input type="hidden" name="id" value={editing.id} />
					<input
						class="input tag-add"
						type="text"
						name="name"
						list="tag-names"
						placeholder="+ tag"
						title="Add a Tag — type a new name to create it"
					/>
				</form>
			</div>
		</div>

		<form method="POST" action={act('correct')} class="section">
			<h3 class="t-label">Correct the Category</h3>
			<input type="hidden" name="id" value={editing.id} />
			<label class="field">
				<span class="field-label">Category</span>
				<select name="category_id" class="select">
					{@render catOptions(null, editing.category_name)}
				</select>
			</label>
			<label class="field">
				<span class="field-label">…or create new</span>
				<input class="input" type="text" name="new_category" placeholder="e.g. Gift" />
			</label>
			<label class="field">
				<span class="field-label">Also add a Tag (optional)</span>
				<input class="input" type="text" name="tag" list="tag-names" placeholder="e.g. Tax deductible" />
			</label>
			<label class="check">
				<input type="checkbox" name="apply_future" checked={!editing.ambiguous} />
				<span>
					Apply to future matches
					{#if editing.ambiguous}
						<span class="t-body-sm t-muted">(off — ambiguous payee)</span>
					{/if}
				</span>
			</label>
			<div class="row" style="gap: var(--space-2); justify-content: flex-end;">
				<button class="btn btn-tertiary" type="button" onclick={closeDialog}>Cancel</button>
				<button class="btn btn-primary" type="submit">Save Correction</button>
			</div>
		</form>
	</dialog>
{/if}

<!-- ————— Bulk mode: the same dialog idea over the selection ————— -->
{#if bulkOpen}
	<dialog class="correction detail" bind:this={bulkDialogEl} onclose={() => (bulkOpen = false)}>
		<div class="row-between" style="align-items: start;">
			<h2 class="t-title-md">{selected.length} selected</h2>
			<button
				class="btn btn-tertiary btn-sm btn-icon"
				type="button"
				onclick={() => bulkDialogEl?.close()}
				title="Close"
			>
				<X />
			</button>
		</div>

		<ul class="bulk-list t-body-sm">
			{#each selectedRows as row (row.id)}
				<li class="row-between">
					<span><span class="t-mono-sm t-muted">{row.date}</span> {row.merchant ?? row.name}</span>
					<span class="t-mono-sm">{fmtUSD(row.amount_cents)}</span>
				</li>
			{/each}
		</ul>

		<!-- bulk Correction never mints a Rule (CONTEXT.md) — one-off batch fix -->
		<form method="POST" action={act('bulkCorrect')} class="section">
			{@render bulkIds()}
			<label class="field">
				<span class="field-label">Set Category on all</span>
				<select name="category_id" class="select">
					{@render catOptions(null, null)}
				</select>
			</label>
			<button class="btn btn-primary btn-sm" type="submit">
				Categorize {selected.length} — one-off, no Rule
			</button>
		</form>

		<form method="POST" action={act('bulkTag')} class="section row" style="align-items: end;">
			{@render bulkIds()}
			<label class="field">
				<span class="field-label">Tag all as</span>
				<input class="input" type="text" name="name" list="tag-names" required />
			</label>
			<button class="btn btn-secondary btn-sm" type="submit">Tag</button>
		</form>

		<form method="POST" action={act('bulkUntag')} class="section row" style="align-items: end;">
			{@render bulkIds()}
			<label class="field">
				<span class="field-label">Remove Tag from all</span>
				<input class="input" type="text" name="name" list="tag-names" required />
			</label>
			<button class="btn btn-secondary btn-sm" type="submit">Untag</button>
		</form>

		<form
			method="POST"
			action={act('bulkLookup')}
			class="section"
			onsubmit={(e) =>
				confirmScan(
					e,
					`Search enrolled Inboxes for receipts on the ${selected.length} selected charges?`,
					selected.length
				)}
		>
			{@render bulkIds()}
			<button class="btn btn-tertiary btn-sm" type="submit">
				<MailSearch /> Search receipts on {selected.length}
			</button>
		</form>
	</dialog>
{/if}

<style>
	.bulk-bar {
		gap: var(--space-3);
		margin-bottom: var(--space-3);
		opacity: 0.6;
	}
	.bulk-bar.active {
		opacity: 1;
	}
	.rowlink {
		cursor: pointer;
	}
	.tags-cell {
		white-space: nowrap;
	}
	.tag-add {
		width: 110px;
		padding-block: 2px;
		font-size: 0.8em;
	}
	.tag-add:not(:focus)::placeholder {
		opacity: 0.5;
	}
	.receipt-facts {
		margin-bottom: var(--space-3);
		padding: var(--space-3) var(--space-4);
		border: var(--border-width) solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-elevated);
	}
	.receipt-facts ul {
		margin-top: var(--space-2);
		list-style: none;
	}
	.section {
		margin-top: var(--space-4);
		padding-top: var(--space-3);
		border-top: var(--border-width) solid var(--color-border);
	}
	.section .t-label {
		margin-bottom: var(--space-2);
	}
	.rules {
		list-style: none;
	}
	.bulk-list {
		margin-top: var(--space-3);
		max-height: 240px;
		overflow-y: auto;
		list-style: none;
	}
</style>
