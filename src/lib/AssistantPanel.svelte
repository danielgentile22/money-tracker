<script lang="ts">
	import { MessageSquarePlus, Trash2, ThumbsUp, ThumbsDown, X, ChevronLeft } from '@lucide/svelte';
	import type { Conversation, Message } from '$lib/server/conversations';
	import type { AuditEntry } from '$lib/server/assistant';

	let { open = $bindable(false) }: { open: boolean } = $props();

	// The panel is a place, not a popup: it stays mounted while the app runs,
	// so closing and reopening lands on the same conversation.
	let conversations = $state<Conversation[]>([]);
	let activeId = $state<number | null>(null);
	let messages = $state<Message[]>([]);
	let view = $state<'list' | 'chat'>('chat');
	let input = $state('');
	let busy = $state(false);
	let unavailable = $state(false);
	let sendFailed = $state(false);
	let loaded = false;

	$effect(() => {
		if (open && !loaded) {
			loaded = true;
			refreshThreads();
		}
	});

	async function refreshThreads() {
		conversations = (await (await fetch('/assistant')).json()).conversations;
	}

	async function openThread(id: number) {
		activeId = id;
		view = 'chat';
		messages = (await (await fetch(`/assistant/${id}`)).json()).messages;
	}

	function newThread() {
		activeId = null;
		messages = [];
		unavailable = false;
		view = 'chat';
	}

	async function removeThread(id: number) {
		await fetch(`/assistant/${id}`, { method: 'DELETE' });
		if (activeId === id) newThread();
		await refreshThreads();
	}

	async function send() {
		const text = input.trim();
		if (!text || busy) return;
		input = '';
		unavailable = false;
		sendFailed = false;
		busy = true;
		// optimistic echo — the server persists the owner message either way
		messages = [...messages, { id: -1, conversation_id: activeId ?? -1, role: 'user', content: text, feedback: null, tool_audit: null, created_at: '' }];
		let sent = false; // once the POST succeeds the message is persisted — never roll back after
		try {
			const res = await fetch('/assistant', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ conversationId: activeId, text })
			});
			if (!res.ok) throw new Error(`send failed: ${res.status}`);
			sent = true;
			const result = (await res.json()) as { ok: boolean; conversationId: number };
			activeId = result.conversationId;
			if (!result.ok) unavailable = true;
			messages = (await (await fetch(`/assistant/${activeId}`)).json()).messages;
			await refreshThreads();
		} catch {
			if (!sent) {
				// never reached the server — undo the optimistic echo, give the text back
				messages = messages.filter((m) => m.id !== -1);
				input = text;
				sendFailed = true;
			}
			// else: persisted but the refresh fetch failed — keep the optimistic bubble
		} finally {
			busy = false;
		}
	}

	async function thumb(m: Message, dir: 'up' | 'down') {
		const feedback = m.feedback === dir ? null : dir; // click again to clear
		try {
			const res = await fetch(`/assistant/${m.conversation_id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ messageId: m.id, feedback })
			});
			if (!res.ok) return; // don't show feedback the server didn't record
		} catch {
			return;
		}
		messages = messages.map((x) => (x.id === m.id ? { ...x, feedback } : x));
	}

	const audit = (m: Message): AuditEntry[] => (m.tool_audit ? JSON.parse(m.tool_audit) : []);

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && open) open = false;
	}
</script>

<svelte:window {onkeydown} />

{#if open}
	<aside class="assistant-panel surface" aria-label="AI Assistant">
		<header class="panel-head">
			{#if view === 'chat'}
				<button class="btn btn-tertiary btn-sm" onclick={() => (view = 'list')} aria-label="Conversations">
					<ChevronLeft /> Threads
				</button>
			{:else}
				<span class="eyebrow">Conversations</span>
			{/if}
			<span class="row" style="gap: var(--space-2);">
				<button class="btn btn-tertiary btn-sm" onclick={newThread} aria-label="New conversation">
					<MessageSquarePlus />
				</button>
				<button class="btn btn-tertiary btn-sm" onclick={() => (open = false)} aria-label="Close">
					<X />
				</button>
			</span>
		</header>

		{#if view === 'list'}
			<div class="panel-body">
				{#if conversations.length === 0}
					<p class="t-body-sm t-muted">No conversations yet — ask your first question.</p>
				{/if}
				{#each conversations as c (c.id)}
					<div class="thread-row">
						<button class="thread-title" onclick={() => openThread(c.id)}>{c.title}</button>
						<button class="btn btn-tertiary btn-sm" onclick={() => removeThread(c.id)} aria-label="Delete conversation">
							<Trash2 />
						</button>
					</div>
				{/each}
			</div>
		{:else}
			<div class="panel-body">
				{#if messages.length === 0}
					<p class="t-body-sm t-muted">
						Ask about your finances in plain language — "what patterns should I worry about this
						month?", "how much did I spend on coffee last year?" — or about how the app works.
						Answers come from the same engines the pages use, through read-only tools; every tool
						call is audited below the reply.
					</p>
				{/if}
				{#each messages as m (m.id)}
					<div class="msg" data-role={m.role}>
						<p class="t-body-md msg-text">{m.content}</p>
						{#if m.role === 'assistant'}
							<div class="row" style="gap: var(--space-2); align-items: center;">
								<button
									class="btn btn-tertiary btn-sm"
									aria-pressed={m.feedback === 'up'}
									onclick={() => thumb(m, 'up')}
									aria-label="Helpful"
								>
									<ThumbsUp />
								</button>
								<button
									class="btn btn-tertiary btn-sm"
									aria-pressed={m.feedback === 'down'}
									onclick={() => thumb(m, 'down')}
									aria-label="Not helpful"
								>
									<ThumbsDown />
								</button>
								{#if audit(m).length > 0}
									<details class="audit">
										<summary class="t-body-sm t-muted">
											{audit(m).length} tool call{audit(m).length === 1 ? '' : 's'} — what was sent
										</summary>
										{#each audit(m) as a, i (i)}
											<p class="t-body-sm"><strong>{a.tool}</strong> {JSON.stringify(a.input)}</p>
											<pre class="audit-payload">{JSON.stringify(a.result, null, 1)}</pre>
										{/each}
									</details>
								{/if}
							</div>
						{/if}
					</div>
				{/each}
				{#if busy}
					<p class="t-body-sm t-muted thinking">Thinking — querying your data…</p>
				{/if}
				{#if unavailable}
					<p class="t-body-sm soft-error">
						The AI is unavailable right now — your message is saved. Try again in a moment.
					</p>
				{/if}
				{#if sendFailed}
					<p class="t-body-sm soft-error">
						Couldn't reach the server — nothing was sent. Your question is back in the box below.
					</p>
				{/if}
			</div>
			<form
				class="panel-foot"
				onsubmit={(e) => {
					e.preventDefault();
					send();
				}}
			>
				<input
					class="input"
					style="flex: 1;"
					placeholder="Ask about your finances…"
					bind:value={input}
					disabled={busy}
				/>
				<button class="btn btn-primary btn-sm" type="submit" disabled={busy || !input.trim()}>
					Send
				</button>
			</form>
		{/if}
	</aside>
{/if}

<style>
	.assistant-panel {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		width: min(440px, 100vw);
		z-index: 50;
		display: flex;
		flex-direction: column;
		border-left: var(--border-width) solid var(--color-border);
		border-radius: 0;
		box-shadow: -8px 0 24px rgb(0 0 0 / 0.12);
	}
	.panel-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-3) var(--space-4);
		border-bottom: var(--border-width) solid var(--color-border);
	}
	.panel-body {
		flex: 1;
		overflow-y: auto;
		padding: var(--space-4);
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.panel-foot {
		display: flex;
		gap: var(--space-2);
		padding: var(--space-3) var(--space-4);
		border-top: var(--border-width) solid var(--color-border);
	}
	.thread-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}
	.thread-title {
		background: none;
		border: none;
		padding: var(--space-2) 0;
		cursor: pointer;
		text-align: left;
		flex: 1;
		color: var(--color-text);
		font: inherit;
	}
	.msg[data-role='user'] .msg-text {
		background: var(--color-surface-raised, rgb(0 0 0 / 0.05));
		border-radius: var(--radius-md, 8px);
		padding: var(--space-2) var(--space-3);
		margin-left: var(--space-6);
	}
	.msg-text {
		white-space: pre-wrap;
	}
	.audit {
		max-width: 100%;
	}
	.audit summary {
		cursor: pointer;
	}
	.audit-payload {
		max-height: 200px;
		overflow: auto;
		font-size: 11px;
		background: var(--color-surface-raised, rgb(0 0 0 / 0.05));
		padding: var(--space-2);
		border-radius: var(--radius-sm, 4px);
	}
	.thinking {
		animation: pulse 1.2s ease-in-out infinite;
	}
	@keyframes pulse {
		50% {
			opacity: 0.4;
		}
	}
	.soft-error {
		color: var(--color-danger, #b00020);
	}
</style>
