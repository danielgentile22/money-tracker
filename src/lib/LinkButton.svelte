<script lang="ts">
	import { invalidateAll } from '$app/navigation';

	let {
		connectionId,
		label = 'Add Connection',
		variant = 'btn-primary'
	}: { connectionId?: number; label?: string; variant?: string } = $props();

	let busy = $state(false);
	let errorMsg = $state<string | null>(null);

	// Plaid Link must load from Plaid's CDN — that's egress channel #1 (ADR-0001),
	// loaded only when the owner starts a link.
	async function loadPlaidScript(): Promise<void> {
		if ((window as any).Plaid) return;
		await new Promise<void>((resolve, reject) => {
			const s = document.createElement('script');
			s.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
			s.onload = () => resolve();
			s.onerror = () => reject(new Error('Failed to load Plaid Link'));
			document.head.appendChild(s);
		});
	}

	async function start() {
		busy = true;
		errorMsg = null;
		try {
			const res = await fetch('/accounts/link-token', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ connectionId })
			});
			if (!res.ok) throw new Error((await res.json()).message ?? 'link token failed');
			const { link_token } = await res.json();
			await loadPlaidScript();
			const handler = (window as any).Plaid.create({
				token: link_token,
				onSuccess: async (public_token: string, metadata: any) => {
					if (!connectionId) {
						const ex = await fetch('/accounts/exchange', {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({
								public_token,
								institution_name: metadata.institution?.name ?? 'Unknown'
							})
						});
						if (!ex.ok) {
							errorMsg = (await ex.json()).message ?? 'exchange failed';
							busy = false;
							return;
						}
					} else {
						// update mode: same Item, token unchanged — just mark it healthy again
						await fetch('/accounts/relinked', {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({ connectionId })
						});
					}
					busy = false;
					await invalidateAll();
				},
				onExit: () => {
					busy = false;
				}
			});
			handler.open();
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : String(e);
			busy = false;
		}
	}
</script>

<button class="btn {variant}" onclick={start} disabled={busy}>
	{busy ? 'Opening…' : label}
</button>
{#if errorMsg}
	<p class="t-body-sm" style="color: var(--color-danger); white-space: pre-wrap;">{errorMsg}</p>
{/if}
