import { execFileSync } from 'node:child_process';

// All secrets live in the macOS Keychain under one service (ADR-0002).
// Owner seeds Plaid keys with:
//   security add-generic-password -s money-tracker -a plaid-client-id -w <value>
//   security add-generic-password -s money-tracker -a plaid-secret-sandbox -w <value>
const SERVICE = 'money-tracker';

// `security` exits 44 (errSecItemNotFound) for a genuinely missing item; any
// other status means the Keychain is locked/denied — never proof of absence.
const ERR_SEC_ITEM_NOT_FOUND = 44;

function keychainUnavailable(name: string, e: unknown): Error {
	const status = (e as { status?: number }).status;
	return new Error(`Keychain unavailable reading ${name} (security exited ${status ?? 'unknown'})`);
}

export function getSecret(name: string): string | null {
	try {
		return execFileSync(
			'security',
			['find-generic-password', '-s', SERVICE, '-a', name, '-w'],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
		).trim();
	} catch (e) {
		if ((e as { status?: number }).status === ERR_SEC_ITEM_NOT_FOUND) return null;
		throw keychainUnavailable(name, e);
	}
}

/**
 * Non-fatal probe for ready() checks (root layout, page loads, sync ticks):
 * an unavailable Keychain reads as "not configured" instead of 500-ing every
 * route. Operational reads stay on getSecret, which throws so transient
 * failures never masquerade as revoked credentials.
 */
export function hasSecret(name: string): boolean {
	try {
		return getSecret(name) !== null;
	} catch {
		return false;
	}
}

// ponytail: secret passes through argv, briefly visible in `ps` — acceptable on a
// single-user Mac; switch to `security -i` interactive mode if that ever changes.
export function setSecret(name: string, value: string): void {
	execFileSync('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', name, '-w', value], {
		stdio: 'ignore'
	});
}

export function deleteSecret(name: string): void {
	try {
		execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', name], {
			stdio: 'ignore'
		});
	} catch (e) {
		// already gone is fine; anything else must abort teardown before the
		// caller drops the DB row and strands the token
		if ((e as { status?: number }).status !== ERR_SEC_ITEM_NOT_FOUND)
			throw keychainUnavailable(name, e);
	}
}
