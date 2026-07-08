<script lang="ts">
	import { Trash2, ArrowUp, ArrowDown } from '@lucide/svelte';
	import ManageDialog from '$lib/ManageDialog.svelte';
	import { actionUrl as act } from '$lib/action-url';
	import { isProtectedCategory } from '$lib/protected-categories';
	import type { CategoryUsage } from '$lib/server/categories';

	type TreeCat = { id: number; name: string; emoji: string | null };
	type TreeGroup = { id: number; name: string; emoji: string | null; categories: TreeCat[] };
	let {
		id,
		name,
		emoji,
		usage,
		tree
	}: {
		id: number;
		name: string;
		emoji: string | null;
		usage: CategoryUsage;
		tree: TreeGroup[];
	} = $props();

	const label = (x: { emoji: string | null; name: string }) =>
		x.emoji ? `${x.emoji} ${x.name}` : x.name;

	const groupId = $derived(tree.find((g) => g.categories.some((c) => c.id === id))?.id);
	const inUse = $derived(usage.txns + usage.rules + usage.mappings + usage.budgets > 0);
	const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
	// the re-home picker states plainly what moves (colliding budget months sum)
	const moves = $derived(
		[
			usage.txns > 0 && n(usage.txns, 'transaction'),
			usage.rules > 0 && n(usage.rules, 'rule'),
			usage.mappings > 0 && n(usage.mappings, 'mapping'),
			usage.budgets > 0 && n(usage.budgets, 'budget month')
		]
			.filter(Boolean)
			.join(', ')
	);
	const otherGroups = $derived(tree.filter((g) => g.id !== groupId));
	const destinations = $derived(
		tree
			.map((g) => ({ ...g, categories: g.categories.filter((c) => c.id !== id) }))
			.filter((g) => g.categories.length > 0)
	);
</script>

<ManageDialog {name} {emoji}>
	<form method="POST" action={act('renameCat')} class="row line">
		<input type="hidden" name="id" value={id} />
		<input class="input emoji" type="text" name="emoji" value={emoji ?? ''} placeholder="🙂" title="Emoji" />
		<input class="input" type="text" name="name" value={name} required />
		<button class="btn btn-secondary btn-sm" type="submit">Save</button>
	</form>

	<div class="row line">
		<form method="POST" action={act('moveCat')} class="row">
			<input type="hidden" name="id" value={id} />
			<select name="group_id" class="select" title="Move to Group">
				{#each otherGroups as g (g.id)}
					<option value={g.id}>{label(g)}</option>
				{/each}
			</select>
			<button class="btn btn-tertiary btn-sm" type="submit">Move</button>
		</form>
		<form method="POST" action={act('nudgeCat')} class="row nudge">
			<input type="hidden" name="id" value={id} />
			<button class="btn btn-tertiary btn-sm btn-icon" name="dir" value="up" title="Move up in pickers"><ArrowUp /></button>
			<button class="btn btn-tertiary btn-sm btn-icon" name="dir" value="down" title="Move down in pickers"><ArrowDown /></button>
		</form>
	</div>

	{#if isProtectedCategory(name)}
		<p class="t-body-sm t-muted line">
			{name} is protected — the app's machinery depends on it, so it can't be deleted.
		</p>
	{:else}
		<form method="POST" action={act('deleteCat')} class="line delete">
			<input type="hidden" name="id" value={id} />
			{#if inUse}
				<label class="t-body-sm" for="dest-{id}">
					Deleting moves its {moves} to:
				</label>
				<div class="row">
					<select id="dest-{id}" name="destination" class="select" required>
						{#each destinations as g (g.id)}
							<optgroup label={label(g)}>
								{#each g.categories as c (c.id)}
									<!-- 'Other' preselected: it's the taxonomy's fallback rung -->
									<option value={c.id} selected={c.name === 'Other'}>{label(c)}</option>
								{/each}
							</optgroup>
						{/each}
					</select>
					<button class="btn btn-secondary btn-sm danger" type="submit">
						<Trash2 /> Delete
					</button>
				</div>
			{:else}
				<p class="t-body-sm t-muted">{name} is not used anywhere — it deletes cleanly.</p>
				<button class="btn btn-secondary btn-sm danger" type="submit">
					<Trash2 /> Delete
				</button>
			{/if}
		</form>
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
	.delete label {
		display: block;
		margin-bottom: var(--space-2);
	}
	.delete .row {
		gap: var(--space-2);
	}
	/* danger is never color-alone: the trash glyph + the word carry the meaning */
	.danger {
		color: var(--color-danger);
	}
	.emoji {
		width: 3.5rem;
	}
</style>
