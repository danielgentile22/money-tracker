<script lang="ts">
	import { goto } from '$app/navigation';
	import { fmtUSD } from '$lib/money';
	import ProgressBar from '$lib/charts/ProgressBar.svelte';
	import Sankey from '$lib/charts/Sankey.svelte';
	import Ledger from '$lib/Ledger.svelte';
	import ManageCategory from '$lib/ManageCategory.svelte';
	import ManageGroup from '$lib/ManageGroup.svelte';
	import { actionUrl } from '$lib/action-url';

	let { data, form } = $props();

	const snap = $derived(data.snapshot);
	const monthLabel = $derived(
		new Date(`${snap.month}-15`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
	);
	const left = $derived(snap.left_to_budget_cents);
	// stepping the cursor never closes an open Category (CONTEXT.md: Month cursor)
	const monthHref = (m: string) =>
		data.detail ? `?month=${m}&category=${data.detail.category_id}` : `?month=${m}`;
	const detailHref = (categoryId: number) => `?month=${snap.month}&category=${categoryId}`;
	// a Category ribbon opens its detail in-page; Group ribbons still list out
	function drill(n: { filterKind?: 'categories' | 'groups'; filterId?: number }) {
		if (!n.filterKind || n.filterId == null) return;
		if (n.filterKind === 'categories') goto(detailHref(n.filterId));
		else goto(`/transactions?${n.filterKind}=${n.filterId}`);
	}

	const trendMax = $derived(
		data.detail ? Math.max(...data.detail.trend.map((p) => p.spent_cents), 1) : 1
	);
	const SERIES_TONE = { upcoming: 'info', late: 'warning', ended: 'neutral' } as const;
	const shortMonth = (m: string) =>
		new Date(`${m}-15`).toLocaleDateString('en-US', { month: 'short' });

	// over = spent past budget + rollover; color is paired with the ▲ marker
	const isOver = (l: (typeof snap.groups)[number]['lines'][number]) =>
		l.budget_cents > 0 && l.actual_cents > l.budget_cents + (l.rollover_cents ?? 0);
</script>

<header class="page-head">
	<span class="eyebrow">Plans</span>
	<h1>Categories</h1>
</header>

{#if form?.message}
	<div class="sync-banner" role="alert"><p class="t-body-sm">{form.message}</p></div>
{/if}

{#if data.detail}
	{@const d = data.detail}
	<section class="surface hero">
		<nav class="month-nav">
			<a class="btn btn-tertiary btn-sm" href={monthHref(data.prev)} aria-label="previous month">‹</a>
			<h2 class="t-title-md">{monthLabel}</h2>
			<a class="btn btn-tertiary btn-sm" href={monthHref(data.next)} aria-label="next month">›</a>
			{#if snap.month !== data.current}
				<a class="t-body-sm" href={monthHref(data.current)}>today</a>
			{/if}
			<!-- close = back to the category list, in the month being viewed -->
			<a class="btn btn-secondary btn-sm close" href="?month={snap.month}">Close ✕</a>
		</nav>
		<div class="detail-head">
			<h2 class="t-title-lg">{d.emoji ? `${d.emoji} ` : ''}{d.name}</h2>
			<span class="chip">{d.group_name}</span>
		</div>
		<div class="hero-numbers">
			<div>
				<span class="t-body-sm t-muted">Spent</span>
				<span class="t-mono-sm" class:over={d.budget_cents > 0 && d.actual_cents > d.budget_cents + (d.rollover_cents ?? 0)}>
					{d.budget_cents > 0 && d.actual_cents > d.budget_cents + (d.rollover_cents ?? 0) ? '▲ ' : ''}{fmtUSD(d.actual_cents)}
				</span>
			</div>
			{#if d.budget_cents > 0}
				<div>
					<span class="t-body-sm t-muted">Budget</span>
					<span class="t-mono-sm">{fmtUSD(d.budget_cents)}</span>
				</div>
			{/if}
			{#if d.rollover_cents !== null}
				<div>
					<span class="t-body-sm t-muted" title="rollover balance entering this month">Rollover ↻</span>
					<span class="t-mono-sm" class:over={d.rollover_cents < 0}>{fmtUSD(d.rollover_cents)}</span>
				</div>
				<div>
					<span class="t-body-sm t-muted" title="budget + rollover − actual">Available</span>
					<span class="t-mono-sm">{fmtUSD(d.available_cents ?? 0)}</span>
				</div>
			{/if}
		</div>
	</section>

	<section class="surface section">
		<h2 class="t-title-md">Monthly spending</h2>
		<!-- each bar is a link: the trend doubles as a time machine (story 12).
		     cursor month is marked by the ● label, never by color alone -->
		<div class="trend">
			{#each d.trend as p (p.month)}
				<a
					class="trend-col"
					class:here={p.month === snap.month}
					href="?month={p.month}&category={d.category_id}"
					title="{p.month}: {fmtUSD(p.spent_cents)}"
					aria-current={p.month === snap.month ? 'true' : undefined}
				>
					<span class="trend-bar" style="height: {Math.round((p.spent_cents / trendMax) * 100)}%"></span>
					<span class="t-body-sm trend-label">{p.month === snap.month ? '●' : ''} {shortMonth(p.month)}</span>
				</a>
			{/each}
		</div>
	</section>

	{#if d.series.length > 0}
		<section class="surface section">
			<h2 class="t-title-md">Recurring</h2>
			<ul>
				{#each d.series as s (s.id)}
					<li class="series-row">
						<a class="t-body name" href="/recurring" title="manage on the Recurring page">{s.merchant}</a>
						<span class="chip" data-tone={SERIES_TONE[s.state]}>{s.state}</span>
						<span class="t-body-sm t-muted">{s.cadence} · next {s.next_expected}</span>
						<span class="t-mono-sm">{fmtUSD(s.last_amount_cents)}</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<h2 class="t-title-md ledger-head">Transactions — {monthLabel}</h2>
	<Ledger rows={d.rows} page={1} hasMore={false} focus={data.focus} tree={data.tree} allTags={d.allTags} />
{:else}

<section class="surface hero">
	<nav class="month-nav">
		<a class="btn btn-tertiary btn-sm" href="?month={data.prev}" aria-label="previous month">‹</a>
		<h2 class="t-title-md">{monthLabel}</h2>
		<a class="btn btn-tertiary btn-sm" href="?month={data.next}" aria-label="next month">›</a>
		{#if snap.month !== data.current}
			<a class="t-body-sm" href="?month={data.current}">today</a>
		{/if}
	</nav>
	<div class="hero-numbers">
		<div>
			<span class="t-body-sm t-muted">Expected income</span>
			<span class="t-mono-sm">{fmtUSD(snap.income.expected_cents)}</span>
		</div>
		<div>
			<span class="t-body-sm t-muted">Allocated</span>
			<span class="t-mono-sm">{fmtUSD(snap.allocated_cents)}</span>
		</div>
		<div>
			<span class="t-body-sm t-muted">Left to budget</span>
			<span class="t-mono-sm left" class:over={left < 0} class:slack={left > 0}>
				{left < 0 ? '▲ ' : ''}{fmtUSD(left)}
			</span>
		</div>
	</div>
	<p class="t-body-sm t-muted">
		{#if left > 0}Positive slack is this month's implicit savings.
		{:else if left < 0}Over-committed — allocations exceed expected income.
		{:else}Balanced to the dollar.{/if}
	</p>
</section>

<section class="surface section">
	<h2 class="t-title-md">Where {monthLabel} went</h2>
	{#if data.flow.links.length === 0}
		<p class="t-body-sm t-muted">No money moved this month.</p>
	{:else}
		<Sankey nodes={data.flow.nodes} links={data.flow.links} onribbon={drill} />
		<p class="t-body-sm t-muted" style="margin-top: var(--space-2);">
			Income Categories flow through the spine into spending Groups. Click a ribbon to see its
			transactions. Transfers between your own Accounts never count.
		</p>
	{/if}
</section>

{#snippet amountForm(action: string, categoryId: number, budget: number)}
	<form method="POST" {action} class="row amt-form">
		<input type="hidden" name="category_id" value={categoryId} />
		<input type="hidden" name="month" value={snap.month} />
		<input
			class="input amt"
			type="number"
			name="dollars"
			min="0"
			step="1"
			value={budget > 0 ? budget / 100 : ''}
			placeholder="$/mo"
			title="budget in dollars; blank clears from this month on"
		/>
		<button class="btn btn-tertiary btn-sm" type="submit">Save</button>
	</form>
{/snippet}

<section class="surface section">
	<div class="group-head">
		<span class="row" style="gap: var(--space-2); align-items: baseline;">
			<h2 class="t-title-md">Income</h2>
			<!-- rename is domain-guarded (the 'Income' name keys budgetMonth); the
			     dialog still adds income Categories and sets the Group emoji -->
			{#each data.tree.filter((g) => g.name === 'Income') as ig (ig.id)}
				<ManageGroup id={ig.id} name={ig.name} emoji={ig.emoji} empty={false} />
			{/each}
		</span>
	</div>
	<ul>
		{#each snap.income.lines as l (l.category_id)}
			<li class="budget-row">
				<a class="t-body name" href={detailHref(l.category_id)}>{l.emoji ? `${l.emoji} ` : ''}{l.name}</a>
				<div class="bar-cell"></div>
				<span class="t-mono-sm">{fmtUSD(l.actual_cents)}{l.budget_cents > 0 ? ` / ${fmtUSD(l.budget_cents)}` : ''}</span>
				<span class="rollover-cell"></span>
				{@render amountForm(actionUrl('set'), l.category_id, l.budget_cents)}
				<span></span>
				<ManageCategory
					id={l.category_id}
					name={l.name}
					emoji={l.emoji}
					usage={data.usage[l.category_id]}
					tree={data.tree}
				/>
			</li>
		{/each}
	</ul>
	<p class="subtotal t-mono-sm t-muted">
		expected {fmtUSD(snap.income.expected_cents)} · received {fmtUSD(snap.income.actual_cents)}
	</p>
</section>

{#each snap.groups as g (g.group_id)}
	<section class="surface section">
		<div class="group-head">
			<span class="row" style="gap: var(--space-2); align-items: baseline;">
				<h2 class="t-title-md">{g.emoji ? `${g.emoji} ` : ''}{g.name}</h2>
				<!-- empty per the taxonomy, not the rendered lines — a Group holding
				     only 'Transfer' has no lines but must not offer Delete -->
				<ManageGroup
					id={g.group_id}
					name={g.name}
					emoji={g.emoji}
					empty={(data.tree.find((t) => t.id === g.group_id)?.categories.length ?? 0) === 0}
				/>
			</span>
			<span class="t-mono-sm t-muted">{fmtUSD(g.actual_cents)} / {fmtUSD(g.budget_cents)}</span>
		</div>
		<ul>
			{#each g.lines as l (l.category_id)}
				<li class="budget-row">
					<a class="t-body name" href={detailHref(l.category_id)}>{l.emoji ? `${l.emoji} ` : ''}{l.name}</a>
					<div class="bar-cell">
						{#if l.budget_cents > 0}
							<ProgressBar value={l.actual_cents} max={l.budget_cents + (l.rollover_cents ?? 0)} label="{l.name} budget" />
						{/if}
					</div>
					<span class="t-mono-sm" class:over={isOver(l)}>
						{isOver(l) ? '▲ ' : ''}{fmtUSD(l.actual_cents)}{l.budget_cents > 0 ? ` / ${fmtUSD(l.budget_cents)}` : ''}
					</span>
					<span class="t-mono-sm rollover-cell">
						{#if l.rollover_cents !== null}
							<span class:over={l.rollover_cents < 0} title="rollover balance entering this month">
								↻ {fmtUSD(l.rollover_cents)}
							</span>
							<span class="t-muted" title="budget + rollover − actual">avail {fmtUSD(l.available_cents)}</span>
						{/if}
					</span>
					{@render amountForm(actionUrl('set'), l.category_id, l.budget_cents)}
					<form method="POST" action={actionUrl('rollover')} title={l.rollover_anchor ? `rollover since ${l.rollover_anchor} — turn off` : 'turn on rollover (starts at $0 this month)'}>
						<input type="hidden" name="category_id" value={l.category_id} />
						<input type="hidden" name="month" value={snap.month} />
						<input type="hidden" name="enable" value={l.rollover_anchor ? '0' : '1'} />
						<button class="btn btn-tertiary btn-sm" class:roll-on={l.rollover_anchor} type="submit">↻</button>
					</form>
					<ManageCategory
						id={l.category_id}
						name={l.name}
						emoji={l.emoji}
						usage={data.usage[l.category_id]}
						tree={data.tree}
					/>
				</li>
			{/each}
		</ul>
	</section>
{/each}

<!-- slice 5: the page is the whole manager — new Groups start here, empty -->
<form method="POST" action={actionUrl('addGroup')} class="row add-group">
	<input class="input" type="text" name="name" placeholder="New Group" required />
	<button class="btn btn-secondary btn-sm" type="submit">Add Group</button>
</form>

{#if data.uncategorized_cents > 0}
	<section class="surface section">
		<div class="group-head">
			<h2 class="t-title-md">❓ Uncategorized</h2>
			<span class="t-mono-sm t-muted">{fmtUSD(data.uncategorized_cents)}</span>
		</div>
		<p class="t-body-sm t-muted">
			Spending this month with no Category yet — categorize it on the
			<a href="/review">review queue</a>.
		</p>
	</section>
{/if}

{/if}

<style>
	.hero {
		padding: var(--space-5);
		margin-bottom: var(--space-4);
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	.month-nav {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}
	.hero-numbers {
		display: flex;
		gap: var(--space-6);
	}
	.hero-numbers div {
		display: flex;
		flex-direction: column;
	}
	.left {
		font-size: var(--font-size-xl, 1.5rem);
	}
	.slack {
		color: var(--color-success, var(--color-text));
	}
	.section {
		padding: var(--space-5);
		margin-bottom: var(--space-4);
	}
	.section > h2 {
		margin-bottom: var(--space-3);
	}
	.group-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
	}
	.subtotal {
		margin-top: var(--space-3);
		text-align: right;
	}
	.budget-row {
		display: grid;
		align-items: center;
		gap: var(--space-4);
		padding: var(--space-3) 0;
		border-top: var(--border-width) solid var(--color-border);
		grid-template-columns: 11rem 1fr 10rem 10rem auto auto auto;
	}
	.add-group {
		gap: var(--space-2);
		margin-bottom: var(--space-4);
	}
	.add-group .input {
		max-width: 200px;
	}
	.name {
		text-decoration: none;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	a.name:hover {
		text-decoration: underline;
	}
	.amt {
		width: 100px;
	}
	.amt-form {
		gap: var(--space-2);
	}
	.over {
		color: var(--color-danger);
	}
	.roll-on {
		color: var(--color-success, inherit);
		font-weight: 700;
	}
	.rollover-cell {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
	}
	.t-mono-sm {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.close {
		margin-left: auto;
	}
	.detail-head {
		display: flex;
		align-items: baseline;
		gap: var(--space-3);
	}
	.trend {
		display: flex;
		align-items: stretch;
		gap: var(--space-1);
	}
	.trend-col {
		flex: 1;
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		align-items: center;
		height: 140px;
		text-decoration: none;
		border-radius: var(--radius-sm, 4px);
	}
	.trend-col:hover {
		background: var(--color-elevated);
	}
	.trend-bar {
		width: 70%;
		min-height: 2px;
		background: var(--color-accent, currentColor);
		border-radius: 3px 3px 0 0;
	}
	.trend-label {
		color: var(--color-text-muted);
		white-space: nowrap;
	}
	.trend-col.here .trend-label {
		color: var(--color-text);
		font-weight: 700;
	}
	.series-row {
		display: flex;
		align-items: baseline;
		gap: var(--space-3);
		padding: var(--space-2) 0;
		border-top: var(--border-width) solid var(--color-border);
	}
	.series-row .t-mono-sm {
		margin-left: auto;
	}
	.ledger-head {
		margin: var(--space-4) 0 var(--space-3);
	}
</style>
