<script lang="ts">
	import { Trash2, ArrowUp, ArrowDown } from '@lucide/svelte';
	import ManageDialog from '$lib/ManageDialog.svelte';
	import { actionUrl as act } from '$lib/action-url';

	let {
		id,
		name,
		emoji,
		empty
	}: {
		id: number;
		name: string;
		emoji: string | null;
		empty: boolean;
	} = $props();
</script>

<ManageDialog {name} {emoji}>
	<div class="row line">
		<form method="POST" action={act('renameGroup')} class="row">
			<input type="hidden" name="id" value={id} />
			<input class="input emoji" type="text" name="emoji" value={emoji ?? ''} placeholder="🙂" title="Emoji" />
			<input class="input" type="text" name="name" value={name} required />
			<button class="btn btn-secondary btn-sm" type="submit">Save</button>
		</form>
		<form method="POST" action={act('nudgeGroup')} class="row nudge">
			<input type="hidden" name="id" value={id} />
			<button class="btn btn-tertiary btn-sm btn-icon" name="dir" value="up" title="Move Group up"><ArrowUp /></button>
			<button class="btn btn-tertiary btn-sm btn-icon" name="dir" value="down" title="Move Group down"><ArrowDown /></button>
		</form>
	</div>

	<form method="POST" action={act('addCat')} class="row line">
		<input type="hidden" name="group_id" value={id} />
		<input class="input emoji" type="text" name="emoji" placeholder="🙂" title="Emoji" />
		<input class="input" type="text" name="name" placeholder="New Category" required />
		<button class="btn btn-tertiary btn-sm" type="submit">Add</button>
	</form>

	{#if empty}
		<form method="POST" action={act('deleteGroup')} class="line">
			<input type="hidden" name="id" value={id} />
			<button class="btn btn-secondary btn-sm danger" type="submit">
				<Trash2 /> Delete Group
			</button>
		</form>
	{:else}
		<p class="t-body-sm t-muted line">To delete this Group, move its Categories out first.</p>
	{/if}
</ManageDialog>

<style>
	.line {
		margin-top: var(--space-3);
		gap: var(--space-2);
	}
	.line + .line {
		border-top: var(--border-width) solid var(--color-border);
		padding-top: var(--space-3);
	}
	.nudge {
		margin-left: auto;
		gap: 0;
	}
	/* danger is never color-alone: the trash glyph + the word carry the meaning */
	.danger {
		color: var(--color-danger);
	}
	.emoji {
		width: 3.5rem;
	}
</style>
