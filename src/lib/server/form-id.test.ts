import { test, expect } from 'vitest';
import { formId } from './form-id';

function fd(entries: Record<string, string>) {
	const f = new FormData();
	for (const [k, v] of Object.entries(entries)) f.set(k, v);
	return f;
}

test('formId parses a positive integer id', () => {
	expect(formId(fd({ id: '42' }))).toBe(42);
	expect(formId(fd({ tag_id: '7' }), 'tag_id')).toBe(7);
});

test('formId rejects missing, NaN, zero, negative, and fractional ids', () => {
	expect(formId(fd({}))).toBeNull(); // Number(null) === 0
	expect(formId(fd({ id: 'abc' }))).toBeNull();
	expect(formId(fd({ id: '0' }))).toBeNull();
	expect(formId(fd({ id: '-3' }))).toBeNull();
	expect(formId(fd({ id: '1.5' }))).toBeNull();
});
