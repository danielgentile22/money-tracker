import { getSecret, setSecret, deleteSecret, hasSecret } from './keychain';
import { db } from './db';
import { buildReceiptQuery } from './matcher';
import { receiptWindowDays } from './resolution';

// Gmail module (ADR-0001 egress channel #3): read-only receipt lookup over the
// owner's enrolled Inboxes. OAuth runs on a localhost redirect against an
// unverified personal Google Cloud app with test users — the consent warning
// is expected, not breakage. Credentials live in the Keychain:
//   security add-generic-password -s money-tracker -a google-client-id -w <client_id>
//   security add-generic-password -s money-tracker -a google-client-secret -w <secret>
// plus one gmail-refresh-token-<address> per enrolled Inbox (written by the app).

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

export function googleReady(): boolean {
	return hasSecret('google-client-id') && hasSecret('google-client-secret');
}

export type InboxRow = {
	id: number;
	address: string;
	status: 'connected' | 'expired';
	enrolled_at: string;
};

export function listInboxes(): InboxRow[] {
	return db
		.prepare('SELECT id, address, status, enrolled_at FROM inboxes ORDER BY id')
		.all() as InboxRow[];
}

// The surface P3.2 consumes; tests implement it with a fake (the P1 PlaidSource
// pattern). Candidates carry metadata + Gmail's snippet; only the ONE matched
// candidate gets its full body fetched (fetchBody), never the also-rans.
export type ChargeFacts = { amount_cents: number; date: string; merchant: string };
export type ReceiptCandidate = {
	inboxAddress: string;
	messageId: string;
	from: string;
	subject: string;
	date: string; // ISO yyyy-mm-dd
	snippet: string;
	body?: string; // filled post-match, capped extracted text
};
export interface ReceiptSource {
	searchReceipts(charge: ChargeFacts): Promise<ReceiptCandidate[]>;
	fetchBody?(inboxAddress: string, messageId: string): Promise<string>;
}

/**
 * Thrown when a receipt search reached NO inbox successfully (all connected
 * inboxes errored, or none are connected). An empty candidate array means a
 * clean no-match; this means "we never actually looked" — the caller must NOT
 * transition receipt state or wipe stored evidence on it.
 */
export class ReceiptSearchUnavailable extends Error {}

/**
 * The real ReceiptSource: one narrow query per charge against every connected
 * Inbox, candidates capped per Inbox. Search returns metadata + snippet only;
 * the matched candidate's body comes via one extra fetchBody call. One dead
 * Inbox never blocks the others.
 */
export const realReceiptSource: ReceiptSource = {
	async searchReceipts(charge) {
		const query = buildReceiptQuery(charge, receiptWindowDays(db));
		const out: ReceiptCandidate[] = [];
		const connected = listInboxes().filter((i) => i.status === 'connected');
		let searched = 0;
		for (const inbox of connected) {
			try {
				const token = await inboxAccessToken(inbox);
				const list = await gmailApi<{ messages?: { id: string }[] }>(
					token,
					`messages?q=${encodeURIComponent(query)}&maxResults=5`
				);
				for (const m of list.messages ?? []) {
					const msg = await gmailApi<{
						snippet?: string;
						internalDate?: string;
						payload?: { headers?: { name: string; value: string }[] };
					}>(token, `messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`);
					const header = (name: string) =>
						msg.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? '';
					out.push({
						inboxAddress: inbox.address,
						messageId: m.id,
						from: header('from'),
						subject: header('subject'),
						date: new Date(Number(msg.internalDate ?? 0)).toISOString().slice(0, 10),
						snippet: msg.snippet ?? ''
					});
				}
				searched++;
			} catch (e) {
				// invalid_grant already marked the row expired; transient failures
				// (429/5xx/network) don't — log them so a dead integration is visible
				// instead of masquerading as a clean no-match (#20).
				console.error(`receipt search failed for inbox ${inbox.address}:`, e);
			}
		}
		// No inbox answered → we never actually looked. Signal it so the caller
		// leaves receipt state (and any stored match) untouched (#05).
		if (searched === 0) throw new ReceiptSearchUnavailable(`no inbox answered (${connected.length} connected)`);
		return out;
	},

	/** Full body of ONE matched message: text/plain part preferred, HTML stripped. */
	async fetchBody(inboxAddress, messageId) {
		const inbox = listInboxes().find(
			(i) => i.address === inboxAddress && i.status === 'connected'
		);
		if (!inbox) throw new Error(`no connected Inbox ${inboxAddress}`);
		const token = await inboxAccessToken(inbox);
		const msg = await gmailApi<{ payload?: GmailPart }>(
			token,
			`messages/${messageId}?format=full`
		);
		return extractText(msg.payload).slice(0, BODY_CAP);
	}
};

// ponytail: 6000 chars of extracted text — receipt line items live near the top
const BODY_CAP = 6000;

type GmailPart = { mimeType?: string; body?: { data?: string }; parts?: GmailPart[] };

function partText(part: GmailPart | undefined, mime: string): string {
	if (!part) return '';
	if (part.mimeType === mime && part.body?.data)
		return Buffer.from(part.body.data, 'base64url').toString('utf8');
	for (const p of part.parts ?? []) {
		const t = partText(p, mime);
		if (t) return t;
	}
	return '';
}

export function extractText(payload?: GmailPart): string {
	const plain = partText(payload, 'text/plain');
	if (plain.trim()) return plain;
	// ponytail: crude tag strip, not an HTML parser — receipts are simple markup
	return partText(payload, 'text/html')
		.replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/\s+/g, ' ')
		.trim();
}

// --- enrollment (authorization-code flow, localhost redirect) ---

// ponytail: OAuth state lives in a module map — single user, single process.
const pendingStates = new Map<string, number>();

class GoogleAuthError extends Error {
	constructor(public code: string) {
		super(`Google auth error: ${code}`);
	}
}

export function beginEnrollment(origin: string): string {
	const clientId = getSecret('google-client-id');
	if (!clientId || !getSecret('google-client-secret')) {
		throw new Error(
			'Google OAuth client missing from Keychain. Run:\n' +
				'  security add-generic-password -s money-tracker -a google-client-id -w <client_id>\n' +
				'  security add-generic-password -s money-tracker -a google-client-secret -w <secret>'
		);
	}
	// sweep abandoned enrollments so the map can't grow for the process lifetime
	for (const [s, exp] of pendingStates) if (exp < Date.now()) pendingStates.delete(s);
	const state = crypto.randomUUID();
	pendingStates.set(state, Date.now() + 10 * 60_000);
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: `${origin}/inboxes/oauth/callback`,
		response_type: 'code',
		scope: SCOPE,
		access_type: 'offline',
		// several Gmails: always show the account picker; always mint a refresh token
		prompt: 'consent select_account',
		state
	});
	return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/** Exchange the callback code, learn the address, store token + row. */
export async function completeEnrollment(
	origin: string,
	code: string,
	state: string
): Promise<string> {
	const expiry = pendingStates.get(state);
	pendingStates.delete(state);
	if (!expiry || expiry < Date.now())
		throw new Error('OAuth state mismatch — start enrollment again from Settings');
	const tokens = await tokenRequest({
		code,
		grant_type: 'authorization_code',
		redirect_uri: `${origin}/inboxes/oauth/callback`
	});
	if (!tokens.refresh_token)
		throw new Error(
			'Google returned no refresh token — remove the app at myaccount.google.com/permissions and re-enroll'
		);
	const profile = await gmailApi<{ emailAddress: string }>(tokens.access_token, 'profile');
	const address = profile.emailAddress;
	setSecret(`gmail-refresh-token-${address}`, tokens.refresh_token);
	db.prepare(
		`INSERT INTO inboxes (address) VALUES (?)
		 ON CONFLICT (address) DO UPDATE SET status = 'connected', enrolled_at = datetime('now')`
	).run(address);
	return address;
}

/** Best-effort remote revocation, then local token + row removal. */
export async function revokeInbox(id: number): Promise<void> {
	const inbox = db.prepare('SELECT id, address FROM inboxes WHERE id = ?').get(id) as
		| Pick<InboxRow, 'id' | 'address'>
		| undefined;
	if (!inbox) return;
	const refresh = getSecret(`gmail-refresh-token-${inbox.address}`);
	if (refresh) {
		await fetch('https://oauth2.googleapis.com/revoke', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ token: refresh })
		}).catch(() => {}); // remote revoke is best-effort; local delete is the guarantee
	}
	deleteSecret(`gmail-refresh-token-${inbox.address}`);
	accessTokens.delete(id);
	db.prepare('DELETE FROM inboxes WHERE id = ?').run(id);
}

// --- token plumbing ---

type TokenResponse = { access_token: string; expires_in: number; refresh_token?: string };

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
	const clientId = getSecret('google-client-id');
	const clientSecret = getSecret('google-client-secret');
	if (!clientId || !clientSecret) throw new Error('Google OAuth client missing from Keychain');
	const res = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ ...params, client_id: clientId, client_secret: clientSecret })
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new GoogleAuthError(body.error ?? `HTTP ${res.status}`);
	}
	return res.json() as Promise<TokenResponse>;
}

const accessTokens = new Map<number, { token: string; expiresAt: number }>();

/** Cached access token per Inbox; a dead refresh token marks the row expired. */
export async function inboxAccessToken(inbox: Pick<InboxRow, 'id' | 'address'>): Promise<string> {
	const cached = accessTokens.get(inbox.id);
	if (cached && cached.expiresAt > Date.now()) return cached.token;
	const refresh = getSecret(`gmail-refresh-token-${inbox.address}`);
	if (!refresh) {
		markExpired(inbox.id);
		throw new Error(`no refresh token in Keychain for Inbox ${inbox.address}`);
	}
	try {
		const tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh });
		accessTokens.set(inbox.id, {
			token: tokens.access_token,
			expiresAt: Date.now() + (tokens.expires_in - 60) * 1000
		});
		return tokens.access_token;
	} catch (e) {
		// invalid_grant = revoked/expired refresh token → visible in Settings, offers re-enroll
		if (e instanceof GoogleAuthError && e.code === 'invalid_grant') markExpired(inbox.id);
		throw e;
	}
}

function markExpired(inboxId: number): void {
	db.prepare("UPDATE inboxes SET status = 'expired' WHERE id = ?").run(inboxId);
}

async function gmailApi<T>(accessToken: string, path: string): Promise<T> {
	const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
		headers: { authorization: `Bearer ${accessToken}` }
	});
	// ponytail: 429/5xx just throw and count as an inbox failure (searchReceipts
	// logs + signals via ReceiptSearchUnavailable) — no backoff for a single-user
	// app; add per-inbox retry if quota errors ever show up in the logs.
	if (!res.ok) throw new Error(`Gmail API ${path}: HTTP ${res.status}`);
	return res.json() as Promise<T>;
}
