import { test, expect, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
import { execFileSync } from 'node:child_process';
import { getSecret, deleteSecret, hasSecret } from './keychain';

const mock = vi.mocked(execFileSync);

// `security` exit statuses: 44 = errSecItemNotFound (genuinely missing),
// anything else = locked Keychain / denied ACL prompt / other failure.
const securityError = (status?: number) => {
	const e = new Error('security failed') as Error & { status?: number };
	e.status = status;
	return e;
};

// no mockReset between tests: each test sets its own implementation, and a
// beforeEach mockReset makes vitest 4 report mock-thrown-but-caught errors
// as test failures.

test('getSecret returns the trimmed secret on success', () => {
	mock.mockReturnValue('s3cret\n');
	expect(getSecret('plaid-client-id')).toBe('s3cret');
});

test('getSecret returns null only for errSecItemNotFound (44)', () => {
	mock.mockImplementation(() => {
		throw securityError(44);
	});
	expect(getSecret('missing')).toBeNull();
});

test('getSecret throws on locked/unavailable Keychain instead of masquerading as missing', () => {
	// exit 36 = errSecInteractionNotAllowed (locked Keychain in an SSH session)
	mock.mockImplementation(() => {
		throw securityError(36);
	});
	expect(() => getSecret('gmail-refresh-token-x')).toThrow(/Keychain unavailable/);
	// no exit status at all (e.g. ENOENT) is also not proof the item is missing
	mock.mockImplementation(() => {
		throw securityError(undefined);
	});
	expect(() => getSecret('gmail-refresh-token-x')).toThrow(/Keychain unavailable/);
});

test('deleteSecret ignores already-gone but rethrows real failures', () => {
	mock.mockImplementation(() => {
		throw securityError(44);
	});
	expect(() => deleteSecret('gone')).not.toThrow();

	mock.mockImplementation(() => {
		throw securityError(36);
	});
	expect(() => deleteSecret('stuck')).toThrow(/Keychain unavailable/);
});

test('hasSecret is a non-fatal probe: unavailable Keychain reads as not configured', () => {
	mock.mockImplementation(() => {
		throw securityError(36);
	});
	expect(hasSecret('plaid-client-id')).toBe(false);
	mock.mockReturnValue('key\n');
	expect(hasSecret('plaid-client-id')).toBe(true);
});
