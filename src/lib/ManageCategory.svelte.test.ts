// Component tests for the per-row Category manager (slice 5): rename/emoji,
// move between Groups, reorder, and Delete with the re-home picker.
import { describe, it, expect, beforeEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { page } from '$app/state';
import ManageCategory from './ManageCategory.svelte';

beforeEach(() => {
	HTMLDialogElement.prototype.showModal = function () {
		this.setAttribute('open', '');
	};
	HTMLDialogElement.prototype.close = function () {
		this.removeAttribute('open');
		this.dispatchEvent(new Event('close'));
	};
	// form actions carry the page's query (the cursor month) via actionUrl
	page.url = new URL('http://localhost:5273/categories?month=2026-06') as typeof page.url;
});

const tree = [
	{
		id: 1,
		name: 'Food & Dining',
		emoji: null,
		categories: [
			{ id: 10, name: 'Coffee', emoji: '☕' },
			{ id: 11, name: 'Groceries', emoji: null }
		]
	},
	{ id: 2, name: 'Other', emoji: null, categories: [{ id: 12, name: 'Other', emoji: null }] }
];

const props = (over: Record<string, unknown> = {}) => ({
	id: 10,
	name: 'Coffee',
	emoji: '☕',
	usage: { txns: 0, rules: 0, mappings: 0, budgets: 0 },
	tree,
	...over
});

function render(p = props()) {
	const target = document.createElement('div');
	document.body.appendChild(target);
	const component = mount(ManageCategory, { target, props: p });
	return {
		target,
		open() {
			target.querySelector<HTMLButtonElement>('button[title^="Manage"]')!.click();
			flushSync();
			return target.querySelector('dialog')!;
		},
		destroy: () => {
			unmount(component);
			target.remove();
		}
	};
}

describe('ManageCategory', () => {
	it('a quiet per-row button opens the manage dialog with rename, move and reorder forms carrying the cursor month', () => {
		const { open, destroy } = render();
		const dialog = open();
		expect(dialog.hasAttribute('open')).toBe(true);

		const rename = dialog.querySelector<HTMLFormElement>('form[action$="/renameCat"]')!;
		expect(rename).not.toBeNull();
		// the action carries the cursor month so the post-save redirect lands back on it
		expect(rename.getAttribute('action')).toBe('?month=2026-06&/renameCat');
		expect(rename.querySelector<HTMLInputElement>('input[name="name"]')!.value).toBe('Coffee');
		expect(rename.querySelector<HTMLInputElement>('input[name="emoji"]')!.value).toBe('☕');

		const move = dialog.querySelector<HTMLFormElement>('form[action$="/moveCat"]')!;
		// the Group select offers the other Groups, not the current one
		const options = [...move.querySelectorAll('option')].map((o) => o.textContent!.trim());
		expect(options).toContain('Other');
		expect(options).not.toContain('Food & Dining');

		expect(dialog.querySelector('form[action$="/nudgeCat"]')).not.toBeNull();
		destroy();
	});

	it('an unused Category deletes plainly — no re-home picker', () => {
		const { open, destroy } = render();
		const dialog = open();
		const del = dialog.querySelector<HTMLFormElement>('form[action$="/deleteCat"]')!;
		expect(del).not.toBeNull();
		expect(del.querySelector('select[name="destination"]')).toBeNull();
		expect(dialog.textContent).toContain('not used anywhere');
		destroy();
	});

	it('an in-use Category states plainly what moves and where before deleting', () => {
		const { open, destroy } = render(
			props({ usage: { txns: 12, rules: 1, mappings: 2, budgets: 3 } })
		);
		const dialog = open();
		const del = dialog.querySelector<HTMLFormElement>('form[action$="/deleteCat"]')!;
		const dest = del.querySelector<HTMLSelectElement>('select[name="destination"]')!;
		expect(dest).not.toBeNull();
		// the picker never offers the Category being deleted
		expect([...dest.querySelectorAll('option')].map((o) => o.textContent!.trim())).not.toContain(
			'☕ Coffee'
		);
		expect(dialog.textContent).toContain('12 transactions');
		expect(dialog.textContent).toContain('1 rule');
		expect(dialog.textContent).toContain('2 mappings');
		expect(dialog.textContent).toContain('3 budget months');
		destroy();
	});

	it('protected Categories offer no Delete at all', () => {
		const { open, destroy } = render(props({ id: 12, name: 'Other', emoji: null }));
		const dialog = open();
		expect(dialog.querySelector('form[action$="/deleteCat"]')).toBeNull();
		expect(dialog.textContent).toContain('protected');
		destroy();
	});
});
