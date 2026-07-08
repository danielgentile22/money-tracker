<script lang="ts">
	import { Trash2 } from '@lucide/svelte';

	let { data, form } = $props();

	const label = (x: { emoji: string | null; name: string }) =>
		x.emoji ? `${x.emoji} ${x.name}` : x.name;
</script>

<header class="page-head">
	<span class="eyebrow">Categorization</span>
	<h1>Rules</h1>
</header>

{#if form?.message}
	<div class="sync-banner" role="alert"><p class="t-body-sm">{form.message}</p></div>
{/if}

{#if data.rules.length === 0}
	<section class="surface" style="padding: var(--space-8); text-align: center;">
		<p class="t-body-sm t-muted">
			No Rules yet — a Correction with “apply to future matches” mints the first one.
		</p>
	</section>
{:else}
	<div class="surface ledger">
		<table>
			<thead>
				<tr>
					<th>Merchant</th>
					<th>Amount range ($)</th>
					<th>Category</th>
					<th>Tags</th>
					<th>Provenance</th>
					<th></th>
				</tr>
			</thead>
			<tbody>
				{#each data.rules as rule (rule.id)}
					<tr>
						<td colspan="6" style="padding: 0;">
							<div class="row rule-row">
								<form method="POST" action="?/update" class="row rule-form">
									<input type="hidden" name="id" value={rule.id} />
									<input class="input" type="text" name="merchant" value={rule.merchant} />
									<span class="row" style="gap: var(--space-1);">
										<input
											class="input num"
											type="number"
											step="0.01"
											min="0"
											name="min"
											placeholder="min"
											value={rule.min_amount_cents == null ? '' : rule.min_amount_cents / 100}
										/>
										<span class="t-muted">–</span>
										<input
											class="input num"
											type="number"
											step="0.01"
											min="0"
											name="max"
											placeholder="max"
											value={rule.max_amount_cents == null ? '' : rule.max_amount_cents / 100}
										/>
									</span>
									<select name="category_id" class="select">
										<option value="" selected={rule.category_id == null}>— tags only —</option>
										{#each data.tree as g (g.id)}
											{#if g.categories.length > 0}
												<optgroup label={label(g)}>
													{#each g.categories as c (c.id)}
														<option value={c.id} selected={c.id === rule.category_id}>{label(c)}</option>
													{/each}
												</optgroup>
											{/if}
										{/each}
									</select>
									<input
										class="input"
										type="text"
										name="tags"
										value={rule.tags}
										placeholder="tags, comma-separated"
										title="Tags this Rule attaches to matches — new names are created"
									/>
									<span class="t-body-sm t-muted provenance" title={rule.provenance}>
										{rule.provenance ?? '—'}
									</span>
									<button class="btn btn-secondary btn-sm" type="submit">Save</button>
								</form>
								<form method="POST" action="?/delete">
									<input type="hidden" name="id" value={rule.id} />
									<button class="btn btn-tertiary btn-sm btn-icon" type="submit" title="Delete Rule">
										<Trash2 />
									</button>
								</form>
							</div>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	<p class="t-body-sm t-muted" style="margin-top: var(--space-3);">
		Saving a Rule re-applies it to past Transactions (your hand Corrections stay put) and attaches
		its Tags to every match. Deleting reverts affected Transactions to the Plaid mapping. A
		“tags only” Rule labels matches without touching their Category.
	</p>
{/if}
