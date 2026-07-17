// Component tests for the per-Group manager (slice 5): rename/emoji, reorder,
// add a Category, and delete — offered only once the Group is empty.
import { describe, it, expect, beforeEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { page } from '$app/state';
import ManageGroup from './ManageGroup.svelte';

// dialog.showModal polyfill lives in src/test/component-setup.ts (#80)
beforeEach(() => {
	// form actions carry the page's query (the cursor month) via actionUrl
	page.url = new URL('http://localhost:5273/categories?month=2026-06') as typeof page.url;
});

const props = (over: Record<string, unknown> = {}) => ({
	id: 3,
	name: 'Travel & Lifestyle',
	emoji: null,
	empty: false,
	...over
});

function render(p = props()) {
	const target = document.createElement('div');
	document.body.appendChild(target);
	const component = mount(ManageGroup, { target, props: p });
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

describe('ManageGroup', () => {
	it('opens with rename, reorder and add-Category forms carrying the cursor month', () => {
		const { open, destroy } = render();
		const dialog = open();
		const rename = dialog.querySelector<HTMLFormElement>('form[action$="/renameGroup"]')!;
		expect(rename.getAttribute('action')).toBe('?month=2026-06&/renameGroup');
		expect(rename.querySelector<HTMLInputElement>('input[name="name"]')!.value).toBe(
			'Travel & Lifestyle'
		);
		expect(dialog.querySelector('form[action$="/nudgeGroup"]')).not.toBeNull();
		const add = dialog.querySelector<HTMLFormElement>('form[action$="/addCat"]')!;
		expect(add.querySelector('input[name="name"]')).not.toBeNull();
		expect(add.querySelector('input[name="emoji"]')).not.toBeNull();
		destroy();
	});

	it('a Group with Categories offers no Delete — they must move out first', () => {
		const { open, destroy } = render();
		const dialog = open();
		expect(dialog.querySelector('form[action$="/deleteGroup"]')).toBeNull();
		expect(dialog.textContent).toContain('move its Categories out first');
		destroy();
	});

	it('an empty Group deletes', () => {
		const { open, destroy } = render(props({ empty: true }));
		const dialog = open();
		expect(dialog.querySelector('form[action$="/deleteGroup"]')).not.toBeNull();
		destroy();
	});
});
