// Component tests for the shared Ledger (CONTEXT.md: the one surface that
// lists Transactions). First component tests in the repo — vitest + jsdom +
// svelte mount, no testing-library.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { page } from '$app/state';
import Ledger from './Ledger.svelte';

// dialog.showModal polyfill lives in src/test/component-setup.ts (#80)
beforeEach(() => {
	vi.restoreAllMocks();
	page.url = new URL('http://localhost:5273/transactions') as typeof page.url;
});

const row = (over: Record<string, unknown> = {}) => ({
	id: 1,
	date: '2026-07-01',
	merchant: 'Starbucks',
	name: 'STARBUCKS #1234',
	amount_cents: -575,
	pending: 0,
	unresolved: 0,
	is_transfer: 0,
	is_excluded: 0,
	is_saved: 0,
	category_source: 'rule',
	receipt_search_state: null,
	receipt_facts_json: null,
	account_name: 'Checking',
	category_name: 'Coffee',
	recurring_cadence: null,
	recurring_typical_cents: null,
	ambiguous: false,
	tags: [] as { id: number; name: string }[],
	...over
});

const props = (over: Record<string, unknown> = {}) => ({
	rows: [row()],
	page: 1,
	hasMore: false,
	focus: null,
	tree: [
		{
			id: 1,
			name: 'Spending',
			emoji: null,
			categories: [
				{ id: 10, name: 'Coffee', emoji: null },
				{ id: 11, name: 'Groceries', emoji: null }
			]
		}
	],
	allTags: [{ id: 5, name: 'Tax deductible' }],
	...over
});

function render(p = props()) {
	const target = document.createElement('div');
	document.body.appendChild(target);
	const component = mount(Ledger, { target, props: p });
	return {
		target,
		destroy: () => {
			unmount(component);
			target.remove();
		}
	};
}

describe('Ledger rows', () => {
	it('renders one row per Transaction with merchant, category and amount', () => {
		const { target, destroy } = render(
			props({ rows: [row(), row({ id: 2, merchant: 'Wegmans', category_name: 'Groceries', amount_cents: -12345 })] })
		);
		const rows = target.querySelectorAll('tbody tr');
		expect(rows).toHaveLength(2);
		expect(rows[0].textContent).toContain('Starbucks');
		expect(rows[0].textContent).toContain('Coffee');
		expect(rows[0].textContent).toContain('-$5.75');
		expect(rows[1].textContent).toContain('Wegmans');
		destroy();
	});
});

describe('Ledger pagination', () => {
	it('shows Previous/Next links preserving the current query string', () => {
		const { target, destroy } = render(props({ page: 2, hasMore: true }));
		const links = [...target.querySelectorAll('nav a')] as HTMLAnchorElement[];
		expect(links.map((a) => a.textContent!.trim())).toEqual(['Previous', 'Next']);
		expect(links[0].getAttribute('href')).toBe('?page=1');
		expect(links[1].getAttribute('href')).toBe('?page=3');
		expect(target.querySelector('nav')!.textContent).toContain('Page 2');
		destroy();
	});
});

describe('Ledger selection', () => {
	it('checking rows updates the bulk bar count and enables bulk actions', () => {
		const { target, destroy } = render(
			props({ rows: [row(), row({ id: 2, merchant: 'Wegmans' })] })
		);
		const bulkBtn = [...target.querySelectorAll('button')].find((b) =>
			b.textContent!.includes('Bulk actions')
		)!;
		expect(target.querySelector('.bulk-bar')!.textContent).toContain('0 selected');
		expect(bulkBtn.disabled).toBe(true);

		const boxes = target.querySelectorAll<HTMLInputElement>('tbody input[type="checkbox"]');
		boxes[0].click();
		boxes[1].click();
		flushSync();
		expect(target.querySelector('.bulk-bar')!.textContent).toContain('2 selected');
		expect(bulkBtn.disabled).toBe(false);
		destroy();
	});
});

const stubDetail = () =>
	vi.stubGlobal(
		'fetch',
		vi.fn().mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					rawName: 'STARBUCKS #1234',
					plaid: { primary: null, detailed: null, confidence: null },
					rules: { matches: [], winnerId: null, drifted: false },
					receipt: null,
					transferPeer: null,
					recurring: null
				})
		})
	);

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('Ledger detail', () => {
	it('clicking a row opens its detail dialog; closing returns to the same ledger', async () => {
		stubDetail();
		const { target, destroy } = render();
		expect(target.querySelector('dialog.detail')).toBeNull();

		target.querySelector<HTMLElement>('tbody tr.rowlink')!.click();
		flushSync();
		await tick();
		flushSync();

		const dialog = target.querySelector('dialog.detail')!;
		expect(dialog).not.toBeNull();
		expect(dialog.hasAttribute('open')).toBe(true);
		expect(dialog.textContent).toContain('Starbucks');
		expect(fetch).toHaveBeenCalledWith('/transactions/1/detail');

		dialog.querySelector<HTMLButtonElement>('button[title="Close"]')!.click();
		flushSync();
		expect(target.querySelector('dialog.detail')).toBeNull();
		// the ledger underneath is untouched
		expect(target.querySelectorAll('tbody tr')).toHaveLength(1);
		destroy();
	});
});

describe('Ledger correction', () => {
	async function openDetail(target: HTMLElement, rowIndex = 0) {
		target.querySelectorAll<HTMLElement>('tbody tr.rowlink')[rowIndex].click();
		flushSync();
		await tick();
		flushSync();
		return target.querySelector('dialog.detail')!;
	}

	it('the correction form posts ?/correct for the open row, apply-to-future on by default', async () => {
		stubDetail();
		const { target, destroy } = render();
		const dialog = await openDetail(target);
		const form = dialog.querySelector<HTMLFormElement>('form[action="?/correct"]')!;
		expect(form).not.toBeNull();
		expect(form.querySelector<HTMLInputElement>('input[name="id"]')!.value).toBe('1');
		expect(form.querySelector<HTMLInputElement>('input[name="apply_future"]')!.checked).toBe(true);
		destroy();
	});

	it('apply-to-future defaults off for an ambiguous payee', async () => {
		stubDetail();
		const { target, destroy } = render(props({ rows: [row({ merchant: 'Amazon', ambiguous: true })] }));
		const dialog = await openDetail(target);
		const form = dialog.querySelector<HTMLFormElement>('form[action="?/correct"]')!;
		expect(form.querySelector<HTMLInputElement>('input[name="apply_future"]')!.checked).toBe(false);
		expect(form.textContent).toContain('ambiguous payee');
		destroy();
	});

	it('saving a Correction keeps the page state — form actions carry the current query', async () => {
		// the audit loop: a plain-form POST re-renders at the action URL, so the
		// action must carry ?month=&category= or the cursor and open detail reset
		page.url = new URL('http://localhost:5273/categories?month=2026-06&category=4') as typeof page.url;
		stubDetail();
		const { target, destroy } = render();
		const dialog = await openDetail(target);
		const correct = dialog.querySelector<HTMLFormElement>('form[action$="/correct"]')!;
		expect(correct.getAttribute('action')).toBe('?month=2026-06&category=4&/correct');
		const tag = dialog.querySelector<HTMLFormElement>('form[action$="/tag"]')!;
		expect(tag.getAttribute('action')).toBe('?month=2026-06&category=4&/tag');
		destroy();
	});

	it('bulk correction posts ?/bulkCorrect with the selected ids and no apply-to-future', () => {
		const { target, destroy } = render(
			props({ rows: [row(), row({ id: 2, merchant: 'Wegmans' })] })
		);
		for (const box of target.querySelectorAll<HTMLInputElement>('tbody input[type="checkbox"]'))
			box.click();
		flushSync();
		[...target.querySelectorAll('button')]
			.find((b) => b.textContent!.includes('Bulk actions'))!
			.click();
		flushSync();

		const dialog = target.querySelector('dialog.detail')!;
		expect(dialog.textContent).toContain('2 selected');
		const form = dialog.querySelector<HTMLFormElement>('form[action="?/bulkCorrect"]')!;
		expect(form).not.toBeNull();
		const ids = [...form.querySelectorAll<HTMLInputElement>('input[name="ids"]')].map((i) => i.value);
		expect(ids).toEqual(['1', '2']);
		// bulk Correction never mints a Rule — there is no apply-to-future control
		expect(form.querySelector('input[name="apply_future"]')).toBeNull();
		destroy();
	});
});
