import { test, expect } from 'vitest';
import { buildReceiptQuery, matchReceipt } from './matcher';
import type { ChargeFacts, ReceiptCandidate } from './gmail';

const charge: ChargeFacts = { amount_cents: -6347, date: '2026-06-15', merchant: 'AMZN Mktp US' };

const candidate = (over: Partial<ReceiptCandidate> = {}): ReceiptCandidate => ({
	inboxAddress: 'owner@gmail.com',
	messageId: 'm1',
	from: 'store@example.com',
	subject: 'Your order',
	date: '2026-06-15',
	snippet: '',
	...over
});

const OPTS = { windowDays: 14, minScore: 4 };

// --- query construction: narrow by construction (ADR-0001) ---

test('query carries the amount string, a bounded date window, and Merchant tokens', () => {
	const q = buildReceiptQuery(
		{ amount_cents: -6347, date: '2026-06-15', merchant: 'AMZN Mktp US' },
		14
	);
	expect(q).toContain('"63.47"');
	expect(q).toContain('after:2026/06/01');
	expect(q).toContain('before:2026/06/30'); // +14 days, +1 because Gmail before: is exclusive
	expect(q.toLowerCase()).toContain('amzn');
});

// --- scoring (PRD matcher list) ---

test('exact amount + close date + matching sender wins', () => {
	const good = candidate({
		messageId: 'good',
		from: 'auto-confirm@amzn.example.com',
		subject: 'Order total $63.47',
		date: '2026-06-14'
	});
	expect(matchReceipt(charge, [good], OPTS)).toBe(good);
});

test('two candidates → the higher score wins', () => {
	const weak = candidate({ messageId: 'weak', subject: 'Payment of $63.47', date: '2026-06-08' });
	const strong = candidate({
		messageId: 'strong',
		from: 'orders@amzn.example.com',
		subject: 'Your order: $63.47',
		date: '2026-06-15'
	});
	expect(matchReceipt(charge, [weak, strong], OPTS)?.messageId).toBe('strong');
});

test('below-threshold candidates → no match, never best-of-a-bad-bunch', () => {
	// close date but no amount anywhere visible and no Merchant resemblance
	const bad = candidate({ subject: 'Weekly newsletter', date: '2026-06-15' });
	expect(matchReceipt(charge, [bad], OPTS)).toBeNull();
});

test('coincidental amount far outside the window → no match', () => {
	const far = candidate({ subject: 'Invoice $63.47 from amzn', date: '2026-05-20' });
	expect(matchReceipt(charge, [far], OPTS)).toBeNull();
});

test('window edges: day 14 still scores, day 15 disqualifies', () => {
	const edge = candidate({ subject: 'Order $63.47 amzn', date: '2026-06-29' });
	const past = candidate({ subject: 'Order $63.47 amzn', date: '2026-06-30' });
	expect(matchReceipt(charge, [edge], OPTS)).toBe(edge);
	expect(matchReceipt(charge, [past], OPTS)).toBeNull();
});
