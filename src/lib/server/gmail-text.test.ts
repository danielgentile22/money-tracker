import { test, expect } from 'vitest';
import { extractText } from './gmail';

// #79: extractText walks Gmail's nested MIME tree — text/plain preferred,
// HTML crudely stripped. These are the cases that actually vary in the wild.

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const plain = (s: string) => ({ mimeType: 'text/plain', body: { data: b64(s) } });
const html = (s: string) => ({ mimeType: 'text/html', body: { data: b64(s) } });

test('finds text/plain nested deep in a multipart tree', () => {
	const payload = {
		mimeType: 'multipart/mixed',
		parts: [
			{ mimeType: 'multipart/alternative', parts: [html('<p>ignored</p>'), plain('Total $63.47')] }
		]
	};
	expect(extractText(payload)).toBe('Total $63.47');
});

test('prefers text/plain over an html sibling', () => {
	const payload = { mimeType: 'multipart/alternative', parts: [plain('the plain one'), html('<b>the html one</b>')] };
	expect(extractText(payload)).toBe('the plain one');
});

test('html-only: strips style/script blocks and decodes basic entities', () => {
	const payload = html(
		'<style>.x{color:red}</style><script>evil()</script><div>Ben &amp; Jerry&nbsp;$5.00</div>'
	);
	expect(extractText(payload)).toBe('Ben & Jerry $5.00');
});

test('empty / bodyless payloads yield an empty string, never throw', () => {
	expect(extractText(undefined)).toBe('');
	expect(extractText({ mimeType: 'multipart/mixed', parts: [] })).toBe('');
	expect(extractText({ mimeType: 'text/plain' })).toBe(''); // no body.data
});

test('whitespace-only text/plain falls through to the html part', () => {
	const payload = { mimeType: 'multipart/alternative', parts: [plain('   \n  '), html('<p>real body</p>')] };
	expect(extractText(payload)).toBe('real body');
});
