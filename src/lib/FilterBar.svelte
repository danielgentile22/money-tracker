<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { parseFilters, DATE_PRESETS, type DatePreset, type FilterSet } from '$lib/filters';
	import { ChevronDown, X, Bookmark } from '@lucide/svelte';

	// The shared filter vocabulary, rendered. All state lives in the URL: every
	// control edits searchParams and navigates, so back/forward and bookmarks
	// work by nature. Pages stay thin — their load functions parse the same URL.

	type Option = { id: number | string; label: string; heading?: boolean };
	type Saved = { id: number; name: string; path: string; query: string };

	let {
		tree = [],
		accounts = [],
		tags = [],
		merchants = [],
		saved = [],
		defaultPreset = 'all'
	}: {
		tree?: { id: number; name: string; emoji: string | null; categories: { id: number; name: string; emoji: string | null; disabled: number }[] }[];
		accounts?: { id: number; name: string }[];
		tags?: { id: number; name: string }[];
		merchants?: string[];
		saved?: Saved[];
		defaultPreset?: DatePreset;
	} = $props();

	const PRESET_LABEL: Record<DatePreset, string> = {
		'this-month': 'This month',
		'last-3-months': 'Last 3 months',
		ytd: 'Year to date',
		'last-12-months': 'Last 12 months',
		all: 'All time'
	};

	const f: FilterSet = $derived(parseFilters(page.url.searchParams, defaultPreset));

	const label = (x: { emoji?: string | null; name: string }) =>
		x.emoji ? `${x.emoji} ${x.name}` : x.name;

	const DIMS = $derived([
		{
			key: 'categories',
			title: 'Category',
			options: tree.flatMap((g) => [
				{ id: `g${g.id}`, label: label(g), heading: true },
				...g.categories.map((c) => ({ id: c.id, label: label(c) + (c.disabled ? ' (disabled)' : '') }))
			]) as Option[]
		},
		{ key: 'groups', title: 'Group', options: tree.map((g) => ({ id: g.id, label: label(g) })) as Option[] },
		{ key: 'accounts', title: 'Account', options: accounts.map((a) => ({ id: a.id, label: a.name })) as Option[] },
		{ key: 'tags', title: 'Tag', options: tags.map((t) => ({ id: t.id, label: t.name })) as Option[] },
		{ key: 'merchants', title: 'Merchant', options: merchants.map((m) => ({ id: m, label: m })) as Option[] }
	] as const);

	type DimKey = (typeof DIMS)[number]['key'];

	function apply(mutate: (q: URLSearchParams) => void) {
		const q = new URLSearchParams(page.url.searchParams);
		q.delete('page');
		q.delete('focus');
		mutate(q);
		goto(`?${q}`, { keepFocus: true, noScroll: true });
	}

	function currentValues(key: DimKey, mode: 'include' | 'exclude'): Set<string> {
		const v = f[key]?.[mode];
		return new Set((v ?? []).map(String));
	}

	function submitDim(e: SubmitEvent, key: DimKey) {
		e.preventDefault();
		const form = e.currentTarget as HTMLFormElement;
		const data = new FormData(form);
		const mode = data.get('mode') as 'include' | 'exclude';
		const values = data.getAll('v').map(String).filter(Boolean);
		apply((q) => {
			q.delete(key);
			q.delete(`x${key}`);
			const param = mode === 'exclude' ? `x${key}` : key;
			if (key === 'merchants') for (const v of values) q.append(param, v);
			else if (values.length) q.set(param, values.join(','));
		});
		form.closest('details')?.removeAttribute('open');
	}

	function clearDim(key: DimKey, mode: 'include' | 'exclude') {
		apply((q) => q.delete(mode === 'exclude' ? `x${key}` : key));
	}

	function setPreset(preset: string) {
		if (preset === 'custom') {
			customOpen = true;
			return;
		}
		customOpen = false;
		apply((q) => {
			q.set('date', preset);
			q.delete('from');
			q.delete('to');
		});
	}

	function applyCustom(from: string, to: string) {
		if (!from || !to) return;
		customOpen = false;
		apply((q) => {
			q.delete('date');
			q.set('from', from);
			q.set('to', to);
		});
	}

	let customOpen = $state(false);
	let merchantSearch = $state('');

	const isCustom = $derived(!('preset' in f.date));
	const chips = $derived(
		DIMS.flatMap((d) =>
			(['include', 'exclude'] as const).flatMap((mode) => {
				const ids = f[d.key]?.[mode];
				if (!ids?.length) return [];
				const names = ids.map(
					(id) => d.options.find((o) => String(o.id) === String(id))?.label ?? String(id)
				);
				return [{ key: d.key, mode, text: `${d.title}: ${mode === 'include' ? 'only' : 'except'} ${names.join(', ')}` }];
			})
		)
	);

	// what a saved view captures: the canonical filter query + the page's own params
	const saveQuery = $derived.by(() => {
		const q = new URLSearchParams(page.url.searchParams);
		q.delete('page');
		q.delete('focus');
		return q.toString();
	});

	let renaming = $state<number | null>(null);

	// plain form posts replace the query string — carry the filters through the
	// action URL so the page re-renders with its state intact
	const action = $derived((name: string) => (saveQuery ? `?${saveQuery}&/${name}` : `?/${name}`));
</script>

<div class="filter-bar">
	<div class="row controls">
		<label class="field">
			<span class="field-label">Period</span>
			<select
				class="select"
				value={customOpen || isCustom ? 'custom' : (f.date as { preset: DatePreset }).preset}
				onchange={(e) => setPreset(e.currentTarget.value)}
			>
				{#each DATE_PRESETS as p (p)}
					<option value={p}>{PRESET_LABEL[p]}</option>
				{/each}
				<option value="custom">Custom range…</option>
			</select>
		</label>

		{#if customOpen || isCustom}
			{@const from = 'from' in f.date ? f.date.from : ''}
			{@const to = 'to' in f.date ? f.date.to : ''}
			<form
				class="row"
				style="gap: var(--space-2); align-items: flex-end;"
				onsubmit={(e) => {
					e.preventDefault();
					const d = new FormData(e.currentTarget as HTMLFormElement);
					applyCustom(String(d.get('from') ?? ''), String(d.get('to') ?? ''));
				}}
			>
				<label class="field">
					<span class="field-label">From</span>
					<input class="input" type="date" name="from" value={from} required />
				</label>
				<label class="field">
					<span class="field-label">To</span>
					<input class="input" type="date" name="to" value={to} required />
				</label>
				<button class="btn btn-secondary btn-sm" type="submit">Apply</button>
			</form>
		{/if}

		{#each DIMS as d (d.key)}
			{@const inc = currentValues(d.key, 'include')}
			{@const exc = currentValues(d.key, 'exclude')}
			{@const active = inc.size + exc.size}
			<details class="dropdown">
				<summary class="btn btn-secondary btn-sm" class:filtered={active > 0}>
					{d.title}{active ? ` · ${active}` : ''}
					<ChevronDown size={14} />
				</summary>
				<form class="pane surface" onsubmit={(e) => submitDim(e, d.key)}>
					<div class="row" style="gap: var(--space-3);">
						<label class="check"
							><input type="radio" name="mode" value="include" checked={exc.size === 0} /> Only these</label
						>
						<label class="check"
							><input type="radio" name="mode" value="exclude" checked={exc.size > 0} /> All except</label
						>
					</div>
					{#if d.key === 'merchants'}
						<input
							class="input"
							type="search"
							placeholder="Search merchants…"
							bind:value={merchantSearch}
						/>
					{/if}
					<div class="opts">
						{#each d.options as o (o.id)}
							{#if o.heading}
								<span class="t-body-sm t-muted heading">{o.label}</span>
							{:else if d.key !== 'merchants' || !merchantSearch || o.label
									.toLowerCase()
									.includes(merchantSearch.toLowerCase())}
								<label class="check opt">
									<input
										type="checkbox"
										name="v"
										value={o.id}
										checked={inc.has(String(o.id)) || exc.has(String(o.id))}
									/>
									<span>{o.label}</span>
								</label>
							{/if}
						{/each}
					</div>
					<div class="row" style="justify-content: flex-end; gap: var(--space-2);">
						<button class="btn btn-primary btn-sm" type="submit">Apply</button>
					</div>
				</form>
			</details>
		{/each}

		<!-- saved reports: a bookmark, not a task to rebuild -->
		<details class="dropdown saved">
			<summary class="btn btn-tertiary btn-sm"><Bookmark size={14} /> Saved{saved.length ? ` · ${saved.length}` : ''}</summary>
			<div class="pane surface">
				<form method="POST" action={action('saveReport')} class="row" style="gap: var(--space-2);">
					<input type="hidden" name="query" value={saveQuery} />
					<input class="input" type="text" name="name" placeholder="Name this view…" required />
					<button class="btn btn-secondary btn-sm" type="submit">Save</button>
				</form>
				{#each saved as r (r.id)}
					<div class="row saved-row">
						{#if renaming === r.id}
							<form method="POST" action={action('renameReport')} class="row" style="gap: var(--space-2); flex: 1;">
								<input type="hidden" name="id" value={r.id} />
								<input class="input" type="text" name="name" value={r.name} required />
								<button class="btn btn-secondary btn-sm" type="submit">Rename</button>
							</form>
						{:else}
							<a href="{r.path}?{r.query}" class="saved-link" title={r.query}>{r.name}</a>
							<button class="btn btn-tertiary btn-sm" type="button" onclick={() => (renaming = r.id)}>
								Rename
							</button>
							<form method="POST" action={action('deleteReport')}>
								<input type="hidden" name="id" value={r.id} />
								<button class="btn btn-tertiary btn-sm" type="submit" title="Delete saved report">
									<X size={14} />
								</button>
							</form>
						{/if}
					</div>
				{:else}
					<p class="t-body-sm t-muted">No saved reports yet.</p>
				{/each}
			</div>
		</details>
	</div>

	{#if chips.length > 0}
		<div class="row chips">
			{#each chips as c (c.key + c.mode)}
				<button
					class="chip chip-btn"
					data-tone={c.mode === 'include' ? 'info' : 'warning'}
					onclick={() => clearDim(c.key, c.mode)}
					title="Remove this filter"
				>
					{c.text} <X size={11} />
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.filter-bar {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		margin-bottom: var(--space-4);
	}
	.controls {
		gap: var(--space-2);
		flex-wrap: wrap;
		align-items: flex-end;
	}
	.dropdown {
		position: relative;
	}
	.dropdown summary {
		list-style: none;
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.dropdown summary::-webkit-details-marker {
		display: none;
	}
	.dropdown summary.filtered {
		border-color: var(--color-primary);
	}
	.pane {
		position: absolute;
		z-index: 30;
		top: calc(100% + 4px);
		left: 0;
		min-width: 260px;
		padding: var(--space-3);
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		border: 1px solid var(--color-border-strong);
		border-radius: 10px;
		background: var(--color-elevated);
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
	}
	.saved .pane {
		left: auto;
		right: 0;
		min-width: 320px;
	}
	.opts {
		max-height: 260px;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.heading {
		margin-top: var(--space-2);
	}
	.opt {
		padding-left: var(--space-2);
	}
	.chips {
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.saved-row {
		gap: var(--space-2);
		align-items: center;
		justify-content: space-between;
	}
	.saved-link {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
