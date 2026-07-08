import { execFileSync } from 'node:child_process';

// All secrets live in the macOS Keychain under one service (ADR-0002).
// Owner seeds Plaid keys with:
//   security add-generic-password -s money-tracker -a plaid-client-id -w <value>
//   security add-generic-password -s money-tracker -a plaid-secret-sandbox -w <value>
const SERVICE = 'money-tracker';

export function getSecret(name: string): string | null {
	try {
		return execFileSync(
			'security',
			['find-generic-password', '-s', SERVICE, '-a', name, '-w'],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
		).trim();
	} catch {
		return null;
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
	} catch {
		// already gone
	}
}
