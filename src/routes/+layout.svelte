<script lang="ts">
	import '@fontsource-variable/inter';
	import '@fontsource-variable/jetbrains-mono';
	import '$lib/halo.css';
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { page } from '$app/state';
	import {
		LayoutDashboard,
		List,
		ChartPie,
		Target,
		Repeat,
		Landmark,
		Settings,
		Users,
		ChevronDown
	} from '@lucide/svelte';

	import { invalidateAll } from '$app/navigation';
	import { RefreshCw, Sparkles } from '@lucide/svelte';
	import CommandPalette from '$lib/CommandPalette.svelte';
	import AssistantPanel from '$lib/AssistantPanel.svelte';

	let { children, data } = $props();

	let refreshing = $state(false);
	let assistantOpen = $state(false);

	function shortcut(e: KeyboardEvent) {
		if (data.assistantReady && (e.metaKey || e.ctrlKey) && e.key === 'j') {
			e.preventDefault();
			assistantOpen = !assistantOpen;
		}
	}

	async function refresh() {
		refreshing = true;
		try {
			await fetch('/sync', { method: 'POST' });
		} finally {
			refreshing = false;
			await invalidateAll();
		}
	}

	// launch sync may still be running when the first page renders — poll until done
	$effect(() => {
		if (!data.sync.syncing) return;
		const t = setInterval(() => invalidateAll(), 2000);
		return () => clearInterval(t);
	});

	function lastSynced(ts: string | null): string {
		if (!ts) return 'never synced';
		return `synced ${new Date(ts.replace(' ', 'T') + 'Z').toLocaleString([], {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		})}`;
	}

	// Session 4: the 8-section spine — every tab answers one question.
	// Session 6: order/visibility come from Settings → Layout (data.sidebar);
	// hidden sections stay reachable through the More fold at the bottom.
	const navDefs: Record<string, { label: string; icon: typeof List }> = $derived({
		'/': { label: 'Dashboard', icon: LayoutDashboard },
		'/transactions': { label: 'Transactions', icon: List },
		'/categories': { label: 'Categories', icon: Target },
		'/recurring': { label: 'Recurring', icon: Repeat },
		'/splits': { label: data.splitLabel, icon: Users },
		'/reports': { label: 'Reports', icon: ChartPie },
		'/accounts': { label: 'Accounts', icon: Landmark },
		'/settings': { label: 'Settings', icon: Settings }
	});
	const nav = $derived(
		data.sidebar
			.filter((e) => navDefs[e.id])
			.map((e) => ({ href: e.id, hidden: e.hidden, ...navDefs[e.id] }))
	);
	const shown = $derived(nav.filter((e) => !e.hidden));
	const more = $derived(nav.filter((e) => e.hidden));

	// folded-in pages highlight their host section
	const sectionOf: Record<string, string> = {
		'/review': '/transactions',
		'/projections': '/', // reached from the dashboard Run-rate widget
		'/rules': '/settings',
		'/concerns': '/'
	};

	function current(href: string): 'page' | undefined {
		let path: string = page.url.pathname;
		for (const [folded, host] of Object.entries(sectionOf)) {
			if (path === folded || path.startsWith(folded + '/')) path = host;
		}
		return path === href || (href !== '/' && path.startsWith(href + '/')) ? 'page' : undefined;
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Money Tracker</title>
</svelte:head>

<svelte:window onkeydown={shortcut} />

<CommandPalette splitLabel={data.splitLabel} />

<!-- absent entirely without a key — the key is the opt-in, no second toggle -->
{#if data.assistantReady}
	<AssistantPanel bind:open={assistantOpen} />
{/if}

<div class="shell">
	<aside class="sidebar">
		<a class="nav-brand" href="/">
			<span class="nav-brand-mark"></span>
			Money Tracker
		</a>
		{#each shown as item (item.href)}
			{@const Icon = item.icon}
			<a class="side-link" href={item.href} aria-current={current(item.href)}>
				<Icon />
				{item.label}
			</a>
		{/each}
		{#if more.length > 0}
			<details class="nav-more">
				<summary class="side-link">
					<ChevronDown />
					More
				</summary>
				{#each more as item (item.href)}
					{@const Icon = item.icon}
					<a class="side-link" href={item.href} aria-current={current(item.href)}>
						<Icon />
						{item.label}
					</a>
				{/each}
			</details>
		{/if}
		<div class="sidebar-foot">
			{#if data.assistantReady}
				<button
					class="btn btn-tertiary btn-sm"
					onclick={() => (assistantOpen = !assistantOpen)}
					aria-pressed={assistantOpen}
					aria-label="Assistant (⌘J)"
					title="Assistant (⌘J)"
				>
					<Sparkles />
				</button>
			{/if}
			<button
				class="btn btn-tertiary btn-sm"
				class:spinning={refreshing || data.sync.syncing}
				onclick={refresh}
				disabled={refreshing || data.sync.syncing}
				aria-label="Refresh"
				title={refreshing || data.sync.syncing ? 'Syncing…' : lastSynced(data.sync.lastSyncedAt)}
			>
				<RefreshCw />
			</button>
		</div>
	</aside>
	<main class="content">
		{#if data.sync.failures.length > 0}
			<div class="sync-banner" role="alert">
				{#each data.sync.failures as f (f.institution_name)}
					<p class="t-body-sm">
						<strong>{f.institution_name}</strong> sync {f.health}
						{#if f.health === 'broken'}
							— <a href="/accounts">re-link on the Accounts surface</a>
						{:else if f.last_sync_error}
							— {f.last_sync_error}
						{/if}
					</p>
				{/each}
			</div>
		{/if}
		{@render children()}
	</main>
</div>
