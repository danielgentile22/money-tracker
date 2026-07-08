<script lang="ts">
	import { Trash2, EyeOff, Eye, GripVertical, Lock } from '@lucide/svelte';
	import { invalidateAll } from '$app/navigation';
	import ScanConfirm from '$lib/ScanConfirm.svelte';
	import type { ScanPlan } from '$lib/scan-estimate';
	import type { ScanProgress } from '$lib/server/backfill';
	import { dndzone } from 'svelte-dnd-action';
	import { flip } from 'svelte/animate';
	import type { LayoutEntry, NavEntry, WidgetSize } from '$lib/server/dashboard';

	let { data, form } = $props();

	const label = (x: { emoji: string | null; name: string }) =>
		x.emoji ? `${x.emoji} ${x.name}` : x.name;

	// --- Layout (Session 6): dashboard widgets + sidebar, auto-saved ---
	const FLIP_MS = 150;
	// writable deriveds: dnd/toggles reassign locally, load reruns resync them
	let widgetRows = $derived<LayoutEntry[]>(data.layout.map((e) => ({ ...e })));
	let navRows = $derived<NavEntry[]>(data.sidebar.map((e) => ({ ...e })));

	const widgetDef = (id: string) => data.widgets.find((w) => w.id === id)!;
	const navLabels: Record<string, string> = $derived({
		'/': 'Dashboard',
		'/transactions': 'Transactions',
		'/categories': 'Categories',
		'/recurring': 'Recurring',
		'/splits': data.splitLabel,
		'/reports': 'Reports',
		'/accounts': 'Accounts',
		'/settings': 'Settings'
	});
	const SIZE_ABBR: Record<WidgetSize, string> = { small: 'S', medium: 'M', large: 'L' };

	async function post(action: string, field: string, value: unknown) {
		const fd = new FormData();
		fd.set(field, JSON.stringify(value));
		await fetch(`?/${action}`, { method: 'POST', body: fd });
		await invalidateAll(); // dashboard/sidebar pick the change up on next load
	}
	const saveWidgets = () => post('layout', 'layout', widgetRows);
	const saveNav = () => post('sidebar', 'sidebar', navRows);

	function setWidgetSize(id: string, size: WidgetSize) {
		widgetRows = widgetRows.map((e) => (e.id === id ? { ...e, size } : e));
		saveWidgets();
	}
	function toggleWidget(id: string) {
		widgetRows = widgetRows.map((e) => (e.id === id ? { ...e, hidden: !e.hidden } : e));
		saveWidgets();
	}
	function toggleNav(id: string) {
		navRows = navRows.map((e) => (e.id === id ? { ...e, hidden: !e.hidden } : e));
		saveNav();
	}

	// every Gmail/AI button confirms first: what, how many, time, cost
	let scanConfirm: ScanConfirm | undefined = $state();
	const confirmScan = (e: SubmitEvent, intro: string, plan: ScanPlan) =>
		scanConfirm?.ask(e, intro, plan);

	// --- scan progress bar: poll while a scan runs, settle back to load data ---
	let live = $state<{ running: boolean; progress: ScanProgress | null } | null>(null);
	$effect(() => {
		if (!data.backfilling) {
			live = null;
			return;
		}
		let stop = false;
		(async () => {
			while (!stop) {
				try {
					const res = await fetch('/settings/scan-progress');
					const next = (await res.json()) as { running: boolean; progress: ScanProgress | null };
					if (stop) return;
					live = next;
					if (!next.running) {
						await invalidateAll(); // refresh track record + final message
						return;
					}
				} catch {
					/* transient — keep polling */
				}
				await new Promise((r) => setTimeout(r, 1500));
			}
		})();
		return () => {
			stop = true;
		};
	});
	const scanning = $derived(live ? live.running : data.backfilling);
	const scanProg = $derived(live?.progress ?? data.backfillProgress);
</script>

<!-- Grouped Category picker (story 13) — the Plaid-mapping rows' tree. -->
{#snippet catOptions(selectedId: number | null)}
	{#each data.tree as g (g.id)}
		{#if g.categories.length > 0}
			<optgroup label={label(g)}>
				{#each g.categories as c (c.id)}
					<option value={c.id} selected={c.id === selectedId}>{label(c)}</option>
				{/each}
			</optgroup>
		{/if}
	{/each}
{/snippet}

<header class="page-head">
	<span class="eyebrow">Configuration</span>
	<h1>Settings</h1>
</header>

<ScanConfirm bind:this={scanConfirm} />

{#if form?.message}
	<div class="sync-banner" role="alert"><p class="t-body-sm">{form.message}</p></div>
{/if}

{#if data.inboxEnrolled}
	<div class="sync-banner" role="status">
		<p class="t-body-sm">Inbox {data.inboxEnrolled} enrolled — receipt lookup now covers it.</p>
	</div>
{/if}
{#if data.inboxError}
	<div class="sync-banner" role="alert">
		<p class="t-body-sm">Inbox enrollment failed: {data.inboxError}</p>
	</div>
{/if}

<!-- Layout first: the knobs the dashboard and sidebar no longer carry themselves -->
<section class="surface" style="padding: var(--space-5); margin-bottom: var(--space-4);">
	<h2 class="t-title-md" style="margin-bottom: var(--space-2);">Layout</h2>
	<p class="t-body-sm t-muted" style="margin-bottom: var(--space-4);">
		Drag to reorder. Changes save immediately. Hidden sidebar sections stay reachable under
		“More” at the bottom of the sidebar.
	</p>

	<div class="layout-cols">
		<div>
			<span class="eyebrow" style="display: block; margin-bottom: var(--space-3);">
				Dashboard widgets
			</span>
			<ul
				class="layout-list"
				use:dndzone={{ items: widgetRows, flipDurationMs: FLIP_MS }}
				onconsider={(e) => (widgetRows = e.detail.items)}
				onfinalize={(e) => {
					widgetRows = e.detail.items;
					saveWidgets();
				}}
			>
				{#each widgetRows as row (row.id)}
					<li class="layout-row" class:dimmed={row.hidden} animate:flip={{ duration: FLIP_MS }}>
						<GripVertical class="grip" />
						<span class="t-body-sm layout-name">{widgetDef(row.id).name}</span>
						<span class="row size-picker" role="group" aria-label="{widgetDef(row.id).name} size">
							{#each widgetDef(row.id).sizes as s (s)}
								<button
									class="btn btn-sm {row.size === s ? 'btn-primary' : 'btn-tertiary'}"
									onclick={() => setWidgetSize(row.id, s)}
									aria-pressed={row.size === s}
									title={s}
								>
									{SIZE_ABBR[s]}
								</button>
							{/each}
						</span>
						<button
							class="btn btn-tertiary btn-sm"
							onclick={() => toggleWidget(row.id)}
							aria-label={row.hidden ? `Show ${widgetDef(row.id).name}` : `Hide ${widgetDef(row.id).name}`}
						>
							{#if row.hidden}<Eye />{:else}<EyeOff />{/if}
						</button>
					</li>
				{/each}
			</ul>
		</div>

		<div>
			<span class="eyebrow" style="display: block; margin-bottom: var(--space-3);">Sidebar</span>
			<ul
				class="layout-list"
				use:dndzone={{ items: navRows, flipDurationMs: FLIP_MS }}
				onconsider={(e) => (navRows = e.detail.items)}
				onfinalize={(e) => {
					navRows = e.detail.items;
					saveNav();
				}}
			>
				{#each navRows as row (row.id)}
					<li class="layout-row" class:dimmed={row.hidden} animate:flip={{ duration: FLIP_MS }}>
						<GripVertical class="grip" />
						<span class="t-body-sm layout-name">{navLabels[row.id]}</span>
						{#if row.id === '/settings'}
							<!-- the escape hatch: always visible, or there's no way back here -->
							<Lock class="grip" aria-label="Settings can't be hidden" />
						{:else}
							<button
								class="btn btn-tertiary btn-sm"
								onclick={() => toggleNav(row.id)}
								aria-label={row.hidden ? `Show ${navLabels[row.id]}` : `Hide ${navLabels[row.id]}`}
							>
								{#if row.hidden}<Eye />{:else}<EyeOff />{/if}
							</button>
						{/if}
					</li>
				{/each}
			</ul>
		</div>
	</div>
</section>

<section class="surface" style="padding: var(--space-5); margin-bottom: var(--space-4);">
	<div class="row-between" style="flex-wrap: wrap; gap: var(--space-3);">
		<div>
			<h2 class="t-title-md">Categories &amp; Groups</h2>
			<p class="t-body-sm t-muted" style="margin-top: var(--space-2);">
				Create, rename, regroup, and delete Categories where you see them — on the Categories page.
			</p>
		</div>
		<a class="btn btn-secondary btn-sm" href="/categories">Manage Categories →</a>
	</div>
</section>

<!-- Session 4 fold-in: rule management lives with the rest of configuration -->
<section class="surface" style="padding: var(--space-5); margin-bottom: var(--space-4);">
	<div class="row-between" style="flex-wrap: wrap; gap: var(--space-3);">
		<div>
			<h2 class="t-title-md">Rules</h2>
			<p class="t-body-sm t-muted" style="margin-top: var(--space-2);">
				Categorization rules — what applies automatically when Transactions sync.
			</p>
		</div>
		<a class="btn btn-secondary btn-sm" href="/rules">Manage Rules →</a>
	</div>
</section>

<section class="surface" style="padding: var(--space-5); margin-bottom: var(--space-4);">
	<div class="row-between" style="margin-bottom: var(--space-4); flex-wrap: wrap; gap: var(--space-3);">
		<h2 class="t-title-md">Tags</h2>
		<form method="POST" action="?/addTag" class="row" style="gap: var(--space-2);">
			<input class="input" style="max-width: 200px;" type="text" name="name" placeholder="New Tag" required />
			<button class="btn btn-secondary btn-sm" type="submit">Add Tag</button>
		</form>
	</div>

	{#if data.tags.length === 0}
		<p class="t-body-sm t-muted">No Tags yet — create one here or inline while tagging a Transaction.</p>
	{:else}
		<ul>
			{#each data.tags as t (t.id)}
				<li class="row cat-row">
					<form method="POST" action="?/renameTag" class="row" style="gap: var(--space-2);">
						<input type="hidden" name="id" value={t.id} />
						<input class="input" style="width: 200px;" type="text" name="name" value={t.name} />
						<button class="btn btn-tertiary btn-sm" type="submit">Rename</button>
					</form>
					<span class="t-body-sm t-muted usage">{t.usage} transactions</span>
					<form
						method="POST"
						action="?/deleteTag"
						onsubmit={(e) => {
							if (!confirm(`Delete "${t.name}"? It will be removed from ${t.usage} transactions.`))
								e.preventDefault();
						}}
					>
						<input type="hidden" name="id" value={t.id} />
						<button class="btn btn-tertiary btn-sm btn-icon" type="submit" title="Delete Tag (detaches everywhere)">
							<Trash2 />
						</button>
					</form>
				</li>
			{/each}
		</ul>
	{/if}
	<p class="t-body-sm t-muted" style="margin-top: var(--space-3);">
		Tags cut across Categories (“Vacation 2026”, “Tax deductible”). Deleting one detaches it from
		its Transactions — nothing else changes.
	</p>
</section>

<section class="surface" style="padding: var(--space-5);">
	<h2 class="t-title-md" style="margin-bottom: var(--space-2);">Plaid mapping</h2>
	<p class="t-body-sm t-muted" style="margin-bottom: var(--space-4);">
		Which of your Categories each Plaid category lands in. Changing a row re-categorizes
		plaid-source Transactions only — your Corrections and Rules always win.
	</p>
	<ul>
		{#each data.mappings as m (m.plaid_key)}
			<li class="row cat-row">
				<span class="t-mono-sm" style="flex: 1;">{m.plaid_key}</span>
				<form method="POST" action="?/remap" class="row" style="gap: var(--space-2);">
					<input type="hidden" name="plaid_key" value={m.plaid_key} />
					<select name="category_id" class="select" style="width: 200px;">
						{@render catOptions(m.category_id)}
					</select>
					<button class="btn btn-tertiary btn-sm" type="submit">Save</button>
				</form>
			</li>
		{/each}
	</ul>
</section>

<section class="surface" style="padding: var(--space-5); margin-bottom: var(--space-4);">
	<div class="row-between" style="margin-bottom: var(--space-4);">
		<h2 class="t-title-md">Detectors</h2>
		<form method="POST" action="?/rerunDetectors">
			<button class="btn btn-secondary btn-sm" type="submit" title="Re-evaluate every Detector against current data">
				Re-run detectors now
			</button>
		</form>
	</div>

	<ul>
		{#each data.detectors as d (d.key)}
			<li class="det-row" class:disabled={!d.enabled}>
				<div class="row-between" style="flex-wrap: wrap; gap: var(--space-3);">
					<span class="row" style="gap: var(--space-3);">
						<strong>{d.label}</strong>
						<span class="t-mono-sm t-muted">{d.key}</span>
						{#if d.minFullMonths > 0}
							<span class="chip" data-tone="neutral">needs {d.minFullMonths} mo history</span>
						{/if}
					</span>
					<form method="POST" action="?/toggleDetector">
						<input type="hidden" name="detector" value={d.key} />
						<input type="hidden" name="enabled" value={d.enabled ? '0' : '1'} />
						<button class="btn btn-tertiary btn-sm" type="submit">
							{d.enabled ? 'Disable' : 'Enable'}
						</button>
					</form>
				</div>
				{#if d.knobs.length === 0}
					<p class="t-body-sm t-muted">No thresholds — fires on every match.</p>
				{:else}
					<div class="row" style="gap: var(--space-5); flex-wrap: wrap;">
						{#each d.knobs as k (k.key)}
							<form method="POST" action="?/setKnob" class="row" style="gap: var(--space-2);">
								<input type="hidden" name="detector" value={d.key} />
								<input type="hidden" name="knob" value={k.key} />
								<label class="field">
									<span class="field-label">{k.label} ({k.unit})</span>
									<span class="row" style="gap: var(--space-2);">
										<input
											class="input"
											style="width: 110px;"
											type="number"
											step="any"
											name="value"
											value={k.current}
										/>
										<button class="btn btn-tertiary btn-sm" type="submit">Save</button>
									</span>
								</label>
							</form>
							{#if k.overridden}
								<form method="POST" action="?/resetKnob" style="align-self: flex-end;">
									<input type="hidden" name="detector" value={d.key} />
									<input type="hidden" name="knob" value={k.key} />
									<button class="btn btn-tertiary btn-sm" type="submit" title="Back to default ({k.default}{k.unit})">
										Reset to {k.default}{k.unit}
									</button>
								</form>
							{:else}
								<span class="t-body-sm t-muted" style="align-self: flex-end; padding-bottom: 6px;">
									default
								</span>
							{/if}
						{/each}
					</div>
				{/if}
			</li>
		{/each}
	</ul>
	<p class="t-body-sm t-muted" style="margin-top: var(--space-3);">
		Changes apply on the next sync — or immediately with “Re-run detectors now”. Disabling a
		Detector lets its existing Concerns expire on the next run.
	</p>
</section>

{#if data.plans529.length > 0}
	<section class="surface" style="padding: var(--space-5); margin-bottom: var(--space-4);">
		<div class="row-between" style="margin-bottom: var(--space-4); flex-wrap: wrap; gap: var(--space-3);">
			<h2 class="t-title-md">Projections · 529</h2>
			<form method="POST" action="?/saveReturn" class="row" style="gap: var(--space-2);">
				<label class="field">
					<span class="field-label">Assumed return (%/yr)</span>
					<span class="row" style="gap: var(--space-2);">
						<input class="input" style="width: 90px;" type="number" step="0.1" name="pct" value={data.assumedReturn} />
						<button class="btn btn-tertiary btn-sm" type="submit">Save</button>
					</span>
				</label>
			</form>
		</div>
		{#each data.plans529 as p (p.id)}
			<form method="POST" action="?/save529" class="det-row" style="gap: var(--space-3);">
				<strong>{p.name}</strong>
				<div class="row" style="gap: var(--space-4); flex-wrap: wrap; align-items: flex-end;">
					<input type="hidden" name="account_id" value={p.id} />
					<label class="field">
						<span class="field-label">Beneficiary</span>
						<input class="input" style="width: 140px;" type="text" name="beneficiary" value={p.beneficiary} />
					</label>
					<label class="field">
						<span class="field-label">Age today</span>
						<input class="input" style="width: 80px;" type="number" min="0" max="18" name="age" value={p.age} />
					</label>
					<label class="field">
						<span class="field-label">Target cost ($)</span>
						<input class="input" style="width: 120px;" type="number" min="1" name="target_dollars" value={p.target_dollars} />
					</label>
					<label class="field">
						<span class="field-label">Override contribution ($/mo, blank = detect)</span>
						<input class="input" style="width: 120px;" type="number" min="0" name="override_monthly_dollars" value={p.override_monthly_dollars} />
					</label>
					<button class="btn btn-secondary btn-sm" type="submit">Save</button>
				</div>
			</form>
		{/each}
		<p class="t-body-sm t-muted" style="margin-top: var(--space-3);">
			Detected contributions come from one-sided “Transfer — saved” legs, split evenly across 529
			Accounts — set the override where that guess is wrong.
		</p>
	</section>
{/if}

<section class="surface" style="padding: var(--space-5); margin-bottom: var(--space-4);">
	<div class="row-between" style="margin-bottom: var(--space-2); flex-wrap: wrap; gap: var(--space-3);">
		<h2 class="t-title-md">Inboxes</h2>
		<form method="POST" action="?/enrollInbox">
			<button class="btn btn-secondary btn-sm" type="submit" disabled={!data.googleReady}>
				Enroll a Gmail Inbox
			</button>
		</form>
	</div>
	<p class="t-body-sm t-muted" style="margin-bottom: var(--space-4);">
		Read-only Gmail access for receipt lookup on Unresolved charges. Google will show an
		<strong>“unverified app”</strong> warning during consent — expected, not breakage: this is
		your own personal OAuth client, no verification review. Click “Advanced” → “Go to Money
		Tracker (unsafe)” and grant read-only access.
	</p>

	{#if !data.googleReady}
		<p class="t-body-sm t-muted" style="margin-bottom: var(--space-4);">
			To enable: create a Google Cloud project with an OAuth client (Web application) using
			redirect URI <span class="t-mono-sm">http://localhost:5273/inboxes/oauth/callback</span>,
			enable the Gmail API, add each Gmail as a test user, then seed the Keychain:
		</p>
		<pre class="t-mono-sm t-muted" style="margin-bottom: var(--space-4); overflow-x: auto;">security add-generic-password -s money-tracker -a google-client-id -w &lt;client_id&gt;
security add-generic-password -s money-tracker -a google-client-secret -w &lt;secret&gt;</pre>
	{/if}

	{#if data.inboxes.length === 0}
		<p class="t-body-sm t-muted">No Inboxes enrolled yet.</p>
	{:else}
		<ul>
			{#each data.inboxes as inbox (inbox.id)}
				<li class="row cat-row">
					<span style="flex: 1;">{inbox.address}</span>
					{#if inbox.status === 'connected'}
						<span class="chip" data-tone="success">connected</span>
					{:else}
						<span class="chip" data-tone="danger">token expired</span>
						<form method="POST" action="?/enrollInbox">
							<button class="btn btn-tertiary btn-sm" type="submit" disabled={!data.googleReady}>
								Re-enroll
							</button>
						</form>
					{/if}
					<form method="POST" action="?/revokeInbox">
						<input type="hidden" name="id" value={inbox.id} />
						<button class="btn btn-tertiary btn-sm" type="submit">Revoke</button>
					</form>
				</li>
			{/each}
		</ul>
	{/if}

	<p class="t-body-sm t-muted" style="margin-top: var(--space-3);">
		What leaves this machine on this channel: narrow per-charge searches (the amount, a date
		window, Merchant words) sent to Gmail, and — once a Receipt matches — that single matched
		email (headers + body, capped) sent to the AI to extract Receipt facts and re-judge the
		Category. Never sent: your full
		mailbox, unmatched candidates, account numbers, balances, or anything about Accounts. The
		app can read mail only, never send, modify, or delete it.
	</p>
</section>

<section class="surface" style="padding: var(--space-5); margin-bottom: var(--space-4);">
	<div class="row" style="gap: var(--space-3); margin-bottom: var(--space-2);">
		<h2 class="t-title-md">AI</h2>
		{#if data.anthropicReady}
			<span class="chip" data-tone="success">API key set</span>
		{:else}
			<span class="chip" data-tone="neutral">no API key</span>
		{/if}
	</div>
	<p class="t-body-sm t-muted" style="margin-bottom: var(--space-4);">
		The Anthropic key powers categorization and Receipt facts, Insight narration, the Weekly
		Recap, and the Assistant. It lives in the macOS Keychain, never in a file. Without it
		everything still works — AI slots simply say unavailable and the Assistant stays hidden.
	</p>

	<div class="row" style="gap: var(--space-4); flex-wrap: wrap; align-items: flex-end;">
		<form method="POST" action="?/setAnthropicKey" class="row" style="gap: var(--space-2); align-items: flex-end;">
			<label class="field">
				<span class="field-label">Anthropic API key</span>
				<input class="input" style="width: 280px;" type="password" name="key" placeholder="sk-ant-…" autocomplete="off" />
			</label>
			<button class="btn btn-secondary btn-sm" type="submit">
				{data.anthropicReady ? 'Replace key' : 'Save to Keychain'}
			</button>
		</form>
		{#if data.anthropicReady}
			<form method="POST" action="?/clearAnthropicKey">
				<button class="btn btn-tertiary btn-sm" type="submit">Remove key</button>
			</form>
		{/if}
	</div>

	<form method="POST" action="?/saveModels" class="row" style="gap: var(--space-4); flex-wrap: wrap; align-items: flex-end; margin-top: var(--space-4);">
		<label class="field">
			<span class="field-label">Categorizer &amp; receipt extraction model</span>
			<input class="input" style="width: 220px;" type="text" name="proposer_model" value={data.proposerModel} />
		</label>
		<label class="field">
			<span class="field-label">Narration model</span>
			<input class="input" style="width: 220px;" type="text" name="narrator_model" value={data.narratorModel} />
		</label>
		<label class="field">
			<span class="field-label">Assistant model</span>
			<input class="input" style="width: 220px;" type="text" name="assistant_model" value={data.assistantModel} />
		</label>
		<button class="btn btn-tertiary btn-sm" type="submit">Save models</button>
	</form>

	<h3 class="t-title-sm" style="margin-top: var(--space-5);">Scans</h3>
	<p class="t-body-sm t-muted" style="margin: var(--space-2) 0 var(--space-3);">
		Day to day you never need these: every sync AI-categorizes new Transactions, searches
		enrolled Inboxes for their Receipts, and keeps retrying unmatched charges for two weeks, so
		late-arriving receipt emails are caught automatically. <strong>AI categorization</strong>
		re-judges model-decidable Transactions (your Corrections and Rules are never touched),
		using Receipt facts where present — run it after changing models or after a receipt
		search. <strong>Gmail receipt search</strong> only gathers evidence: a match puts the
		email's facts on the Transaction, nothing is re-categorized — run it after enrolling a
		new Inbox, then run AI categorization to use the new facts. <em>Last month</em> is the light
		catch-up (unmatched recent charges only); <em>every charge</em> redoes all history from
		scratch, matched ones included. Scans run in the background — the bar below tracks them.
	</p>
	<div class="row" style="gap: var(--space-3); align-items: center; flex-wrap: wrap;">
		<span class="t-body-sm" style="min-width: 140px;">AI categorization</span>
		<form
			method="POST"
			action="?/categorizeScan"
			onsubmit={(e) =>
				confirmScan(e, 'Re-categorize last month with AI?', {
					categorize: data.scanPreview.month.categorize,
					search: 0
				})}
		>
			<input type="hidden" name="scope" value="month" />
			<button class="btn btn-secondary btn-sm" type="submit" disabled={!data.anthropicReady || scanning}>
				Last month
			</button>
		</form>
		<form
			method="POST"
			action="?/categorizeScan"
			onsubmit={(e) =>
				confirmScan(e, 'Re-categorize ALL history with AI?', {
					categorize: data.scanPreview.all.categorize,
					search: 0
				})}
		>
			<input type="hidden" name="scope" value="all" />
			<button class="btn btn-tertiary btn-sm" type="submit" disabled={!data.anthropicReady || scanning}>
				Every charge
			</button>
		</form>
	</div>
	<div class="row" style="gap: var(--space-3); align-items: center; flex-wrap: wrap; margin-top: var(--space-2);">
		<span class="t-body-sm" style="min-width: 140px;">Gmail receipt search</span>
		<form
			method="POST"
			action="?/receiptScan"
			onsubmit={(e) =>
				confirmScan(e, "Search last month's unmatched charges for receipts?", {
					categorize: 0,
					search: data.scanPreview.month.search,
					enrichOnly: true
				})}
		>
			<input type="hidden" name="scope" value="month" />
			<button
				class="btn btn-secondary btn-sm"
				type="submit"
				disabled={!data.anthropicReady || data.inboxes.length === 0 || scanning}
			>
				Last month
			</button>
		</form>
		<form
			method="POST"
			action="?/receiptScan"
			onsubmit={(e) =>
				confirmScan(e, 'Search ALL history for receipts, matched charges included?', {
					categorize: 0,
					search: data.scanPreview.all.search,
					enrichOnly: true
				})}
		>
			<input type="hidden" name="scope" value="all" />
			<button
				class="btn btn-tertiary btn-sm"
				type="submit"
				disabled={!data.anthropicReady || data.inboxes.length === 0 || scanning}
			>
				Every charge
			</button>
		</form>
	</div>
	{#if scanning && scanProg}
		<div class="row" style="gap: var(--space-3); align-items: center; margin-top: var(--space-3);">
			<progress value={scanProg.done} max={scanProg.total || undefined} style="flex: 1; max-width: 360px;"
			></progress>
			<span class="t-body-sm t-muted">
				{scanProg.label}{scanProg.total ? ` — ${scanProg.done}/${scanProg.total}` : ''}
			</span>
		</div>
	{:else if scanProg}
		<p class="t-body-sm t-muted" style="margin-top: var(--space-2);">{scanProg.label}</p>
	{/if}
	<p class="t-body-sm t-muted" style="margin-top: var(--space-2);">
		Receipt track record: {data.scanStats['matched'] ?? 0} matched ·
		{data.scanStats['pending'] ?? 0} still retrying · {data.scanStats['exhausted'] ?? 0} searched,
		no receipt · {data.scanStats['never'] ?? 0} never searched
	</p>

	<h3 class="t-title-sm" style="margin-top: var(--space-5);">Household context</h3>
	<p class="t-body-sm t-muted" style="margin: var(--space-2) 0 var(--space-3);">
		Optional. Fill these in and the Assistant calibrates its advice to your situation; leave
		them blank and nothing personal is ever sent. Stored locally like any setting.
	</p>
	<form method="POST" action="?/saveHousehold" class="row" style="gap: var(--space-4); flex-wrap: wrap; align-items: flex-end;">
		<label class="field">
			<span class="field-label">Dependents</span>
			<input class="input" style="width: 120px;" type="text" name="dependents" value={data.household.dependents} />
		</label>
		<label class="field">
			<span class="field-label">Household income</span>
			<input class="input" style="width: 180px;" type="text" name="income" value={data.household.income} />
		</label>
		<label class="field">
			<span class="field-label">Filing status</span>
			<input class="input" style="width: 220px;" type="text" name="filing_status" value={data.household.filing_status} />
		</label>
		<button class="btn btn-tertiary btn-sm" type="submit">Save household context</button>
	</form>
	{#if data.householdBlock}
		<p class="t-body-sm t-muted" style="margin-top: var(--space-3);">
			Sent to the Assistant, exactly as written here:
		</p>
		<pre class="t-body-sm" style="white-space: pre-wrap; margin-top: var(--space-2);">{data.householdBlock}</pre>
	{/if}

	<p class="t-body-sm t-muted" style="margin-top: var(--space-3);">
		What leaves this machine on this channel: for Receipt facts, one matched Receipt email (headers
		+ body, capped) plus the charge's amount, date, and Merchant, and your Category names; for narration and the
		Weekly Recap, the digest — Category totals, trends, top Merchants, moved-to-savings rate,
		Concern and Projection figures; for the Assistant, your questions, your taxonomy, the
		household context above (only if set), and read-only tool payloads — the same aggregates
		and transaction lists your pages render, auditable per reply from the panel. Never sent:
		account numbers, balances, Account names, credentials, or any email beyond the one matched
		Receipt.
	</p>
</section>

<style>
	.det-row {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		padding: var(--space-4) 0;
		border-top: var(--border-width) solid var(--color-border);
	}
	.det-row.disabled > :not(.row-between) {
		opacity: 0.45;
	}
	.cat-row {
		gap: var(--space-3);
		padding: var(--space-2) 0;
		border-top: var(--border-width) solid var(--color-border);
		flex-wrap: wrap;
	}
	.usage {
		flex: 1;
		min-width: 180px;
	}
	.layout-cols {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
		gap: var(--space-6);
	}
	.layout-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.layout-row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-2) var(--space-3);
		border: var(--border-width) solid var(--color-border);
		border-radius: var(--radius-md);
		cursor: grab;
	}
	.layout-row.dimmed .layout-name {
		opacity: 0.55;
	}
	.layout-row :global(.grip) {
		width: 14px;
		height: 14px;
		color: var(--color-text-muted);
		flex-shrink: 0;
	}
	.layout-name {
		flex: 1;
		min-width: 0;
	}
	.size-picker {
		gap: var(--space-1);
	}
</style>
