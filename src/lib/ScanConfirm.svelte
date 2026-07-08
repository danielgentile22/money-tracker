<script lang="ts">
	import { MailSearch } from '@lucide/svelte';
	import { scanPlanDetails, type ScanPlan } from '$lib/scan-estimate';

	// One dialog per page, shared by every Gmail/AI form on it. A form's
	// onsubmit calls ask(e, …), which swallows the submit and shows the plan;
	// OK re-submits natively (bypassing onsubmit, so no re-prompt loop).
	let dialogEl: HTMLDialogElement | undefined = $state();
	let intro = $state('');
	let plan = $state<ScanPlan>({ categorize: 0, search: 0 });
	let pendingForm: HTMLFormElement | null = null;

	const details = $derived(scanPlanDetails(plan));

	export function ask(e: SubmitEvent, title: string, p: ScanPlan) {
		e.preventDefault();
		pendingForm = e.currentTarget as HTMLFormElement;
		intro = title;
		plan = p;
		dialogEl?.showModal();
	}

	function run() {
		dialogEl?.close();
		pendingForm?.submit();
		pendingForm = null;
	}
</script>

<dialog class="correction scan-confirm" bind:this={dialogEl}>
	<div class="stack">
		<div class="row" style="gap: var(--space-3); align-items: flex-start;">
			<span class="icon-well"><MailSearch /></span>
			<h2 class="t-title-md" style="flex: 1;">{intro}</h2>
		</div>
		<ul class="plan t-body-sm">
			{#each details.bullets as b (b)}
				<li>{b}</li>
			{/each}
		</ul>
		<p class="t-body-sm t-muted">
			Expected time: {details.time}. Runs in the background — the page stays usable.
		</p>
		<div class="row" style="gap: var(--space-2); justify-content: flex-end;">
			<button class="btn btn-tertiary" type="button" onclick={() => dialogEl?.close()}>
				Cancel
			</button>
			<button class="btn btn-primary" type="button" onclick={run}>Run it</button>
		</div>
	</div>
</dialog>

<style>
	.scan-confirm {
		max-width: 440px;
	}
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.icon-well {
		display: grid;
		place-items: center;
		width: 36px;
		height: 36px;
		flex-shrink: 0;
		border-radius: var(--radius-md);
		background: var(--color-primary-soft);
		color: var(--color-primary);
	}
	.plan {
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-3) var(--space-4);
		border: var(--border-width) solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-surface, transparent);
	}
	.plan li {
		padding-left: var(--space-4);
		position: relative;
	}
	.plan li::before {
		content: '•';
		position: absolute;
		left: 0;
		color: var(--color-primary);
	}
</style>
