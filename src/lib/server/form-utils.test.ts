import { test, expect } from 'vitest';
import { dollarsToCents } from './form-utils';

test('dollarsToCents accepts $ and comma formatting (the #18 drift bug)', () => {
	expect(dollarsToCents('$40')).toBe(4000);
	expect(dollarsToCents('1,234.56')).toBe(123456);
	expect(dollarsToCents(' 12.5 ')).toBe(1250);
	expect(dollarsToCents('-5')).toBe(-500); // sign preserved; callers abs/reject
	expect(dollarsToCents('')).toBeNull();
	expect(dollarsToCents(null)).toBeNull();
	expect(dollarsToCents('abc')).toBeNull();
});
