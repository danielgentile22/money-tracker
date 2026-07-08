<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Pencil, X } from '@lucide/svelte';

	let {
		name,
		emoji,
		children
	}: {
		name: string;
		emoji: string | null;
		children: Snippet;
	} = $props();

	let open = $state(false);
	let dialogEl: HTMLDialogElement | undefined = $state();
	$effect(() => {
		if (open && dialogEl && !dialogEl.open) dialogEl.showModal();
	});
</script>

<button
	class="btn btn-tertiary btn-sm btn-icon"
	type="button"
	title="Manage {name}"
	onclick={() => (open = true)}
>
	<Pencil />
</button>

{#if open}
	<dialog
		bind:this={dialogEl}
		class="manage"
		onclose={() => (open = false)}
		onclick={(e) => {
			// close only on true backdrop clicks — a click on the dialog's own
			// padding also targets the dialog but must not discard typed input
			if (e.target !== dialogEl || !dialogEl) return;
			const r = dialogEl.getBoundingClientRect();
			if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
				dialogEl.close();
		}}
	>
		<div class="head">
			<h3 class="t-title-md">{emoji ? `${emoji} ` : ''}{name}</h3>
			<button
				class="btn btn-tertiary btn-sm btn-icon"
				type="button"
				title="Close"
				onclick={() => dialogEl?.close()}
			>
				<X />
			</button>
		</div>
		{@render children()}
	</dialog>
{/if}

<style>
	.manage {
		min-width: 22rem;
		padding: var(--space-5);
		border: var(--border-width) solid var(--color-border);
		border-radius: var(--radius-md, 8px);
		background: var(--color-surface);
		color: var(--color-text);
	}
	.manage::backdrop {
		background: rgb(0 0 0 / 0.35);
	}
	.head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: var(--space-3);
	}
</style>
