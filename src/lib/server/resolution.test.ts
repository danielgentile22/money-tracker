import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import { runReceiptSearch, runResolution, triggerLookup } from './resolution';
import { LlmUnavailable, type LlmRequest } from './llm';
import { ReceiptSearchUnavailable, type ChargeFacts, type ReceiptCandidate } from './gmail';

const TODAY = '2026-07-04';

function makeDb() {
	const db = new Database(':memory:');
	migrate(db);
	db.prepare("INSERT INTO connections (institution_name, plaid_item_id) VALUES ('B', 'i')").run();
	db.prepare(
		"INSERT INTO accounts (connection_id, plaid_account_id, name, type, subtype) VALUES (1, 'a1', 'Checking', 'depository', 'checking')"
	).run();
	return db;
}

let seq = 0;
function insertCharge(
	db: Database.Database,
	over: { date?: string; amount_cents?: number; merchant?: string; unresolved?: number } = {}
) {
	return db
		.prepare(
			`INSERT INTO transactions (account_id, plaid_transaction_id, date, name, merchant, amount_cents, unresolved,
			   category_id, category_source)
			 VALUES (1, ?, ?, 'RAW', ?, ?, ?, (SELECT id FROM categories WHERE name = 'Other'), 'plaid') RETURNING id`
		)
		.pluck()
		.get(
			`rx-${++seq}`,
			over.date ?? '2026-07-01',
			over.merchant ?? 'AMZN Mktp US',
			over.amount_cents ?? -6347,
			over.unresolved ?? 1
		) as number;
}

const receipt = (over: Partial<ReceiptCandidate> = {}): ReceiptCandidate => ({
	inboxAddress: 'owner@gmail.com',
	messageId: 'm1',
	from: 'orders@amzn.example.com',
	subject: 'Your order: $63.47',
	date: '2026-07-01',
	snippet: '',
	...over
});

function fakeSource(candidates: ReceiptCandidate[] = []) {
	const searched: ChargeFacts[] = [];
	return {
		searched,
		async searchReceipts(charge: ChargeFacts) {
			searched.push(charge);
			return candidates;
		}
	};
}

const stateOf = (db: Database.Database, id: number) =>
	db
		.prepare('SELECT receipt_search_state AS s, receipt_json AS j FROM transactions WHERE id = ?')
		.get(id) as { s: string | null; j: string | null };

// --- post-sync sweep ---

test('a new Unresolved charge inside the window is searched; a match lands on the row', async () => {
	const db = makeDb();
	const id = insertCharge(db);
	const src = fakeSource([receipt()]);
	await runReceiptSearch(db, src, TODAY);
	const row = stateOf(db, id);
	expect(row.s).toBe('matched');
	expect((JSON.parse(row.j!) as ReceiptCandidate).messageId).toBe('m1');
	expect(src.searched).toHaveLength(1);
});

test('no match → pending, re-searched on the next sync', async () => {
	const db = makeDb();
	const id = insertCharge(db);
	const src = fakeSource([]);
	await runReceiptSearch(db, src, TODAY);
	expect(stateOf(db, id).s).toBe('pending');
	await runReceiptSearch(db, src, TODAY);
	expect(src.searched).toHaveLength(2);
});

test('a pending charge exhausts once it ages past the window — no further searches', async () => {
	const db = makeDb();
	const id = insertCharge(db, { date: '2026-06-25' });
	const src = fakeSource([]);
	await runReceiptSearch(db, src, TODAY); // day 9: searched, pending
	await runReceiptSearch(db, src, '2026-07-10'); // day 15: past the 14-day window
	expect(stateOf(db, id).s).toBe('exhausted');
	expect(src.searched).toHaveLength(1);
});

test('backlog charges already past the window exhaust without ever querying Gmail', async () => {
	const db = makeDb();
	const id = insertCharge(db, { date: '2026-05-01' });
	const src = fakeSource([receipt()]);
	await runReceiptSearch(db, src, TODAY);
	expect(stateOf(db, id).s).toBe('exhausted');
	expect(src.searched).toHaveLength(0);
});

test('resolved, transfer, and still-pending Transactions are never searched', async () => {
	const db = makeDb();
	insertCharge(db, { unresolved: 0 });
	const transferId = insertCharge(db);
	db.prepare('UPDATE transactions SET is_transfer = 1 WHERE id = ?').run(transferId);
	const pendingId = insertCharge(db);
	db.prepare('UPDATE transactions SET pending = 1 WHERE id = ?').run(pendingId);
	const src = fakeSource([]);
	await runReceiptSearch(db, src, TODAY);
	expect(src.searched).toHaveLength(0);
});

// --- dead Gmail connection must never corrupt receipt state (#05, #42) ---

const deadSource = () => ({
	async searchReceipts(): Promise<ReceiptCandidate[]> {
		throw new ReceiptSearchUnavailable('no inbox answered');
	}
});

test('a search where no inbox answered leaves the charge untouched, not exhausted/pending', async () => {
	const db = makeDb();
	const id = insertCharge(db);
	expect(await triggerLookup(db, deadSource(), id, TODAY)).toBe('unsearched');
	expect(stateOf(db, id).s).toBeNull(); // no false state transition
});

test('a dead re-lookup never wipes a prior match (#42)', async () => {
	const db = makeDb();
	const id = insertCharge(db);
	await runReceiptSearch(db, fakeSource([receipt()]), TODAY);
	expect(stateOf(db, id).s).toBe('matched');
	// a later lookup while Gmail is down doesn't search, and keeps the stored receipt
	expect(await triggerLookup(db, deadSource(), id, TODAY)).toBe('unsearched');
	const row = stateOf(db, id);
	expect(row.s).toBe('matched');
	expect((JSON.parse(row.j!) as ReceiptCandidate).messageId).toBe('m1');
	// and a real (successful) no-match re-lookup also keeps it — evidence outlives one empty search
	expect(await triggerLookup(db, fakeSource([]), id, TODAY)).toBe('matched');
	expect(stateOf(db, id).j).not.toBeNull();
});

// --- a match stranded by an LLM outage self-heals on the next sync (#40) ---

test('a matched row left factless by an LLM outage is re-enriched next sync — no Gmail call', async () => {
	const db = makeDb();
	const id = insertCharge(db);
	const dead = async () => {
		throw new LlmUnavailable('no key');
	};
	await runResolution(db, fakeSource([receipt({ snippet: 'AirPods $63.47' })]), dead, TODAY);
	expect(stateOf(db, id).s).toBe('matched');
	expect(txnOf(db, id).facts).toBeNull(); // stranded: matched but no facts

	// next sync: the matched row is not re-searched, but the stored receipt IS re-extracted
	const drySource = fakeSource([]); // Gmail returns nothing this pass
	const { llm, prompts } = cannedLlm([FACTS_REPLY, '{"1": "Entertainment"}']);
	await runResolution(db, drySource, llm, TODAY);
	expect(drySource.searched).toHaveLength(0); // never re-queried Gmail for the matched row
	expect(JSON.parse(txnOf(db, id).facts!).description).toBe('AirPods Pro (2nd gen)');
});

// --- manual re-trigger (story 17: works on ANY Transaction) ---

test('manual lookup re-searches an exhausted charge and resets its state', async () => {
	const db = makeDb();
	const id = insertCharge(db, { date: '2026-05-01' });
	await runReceiptSearch(db, fakeSource(), TODAY); // exhausted, unsearched backlog
	const hit = fakeSource([receipt({ date: '2026-05-02' })]);
	expect(await triggerLookup(db, hit, id, TODAY)).toBe('matched');
	expect(stateOf(db, id).s).toBe('matched');
	// and a manual miss on an aged charge lands back on exhausted
	const id2 = insertCharge(db, { date: '2026-05-01' });
	expect(await triggerLookup(db, fakeSource(), id2, TODAY)).toBe('exhausted');
	expect(stateOf(db, id2).s).toBe('exhausted');
});

test('manual lookup works on a resolved Transaction too', async () => {
	const db = makeDb();
	const id = insertCharge(db, { unresolved: 0 });
	expect(await triggerLookup(db, fakeSource([receipt()]), id, TODAY)).toBe('matched');
});

// --- enrich then categorize: a match auto-applies with a receipt-informed source ---

function cannedLlm(replies: (string | Error)[]) {
	const prompts: string[] = [];
	let i = 0;
	const llm = async (req: LlmRequest) => {
		prompts.push(req.prompt);
		const next = replies[i++];
		if (next instanceof Error) throw next;
		return next;
	};
	return { llm, prompts };
}

const FACTS_REPLY = '{"description": "AirPods Pro (2nd gen)", "vendor": "Apple"}';

const txnOf = (db: Database.Database, id: number) =>
	db
		.prepare(
			`SELECT t.receipt_facts_json AS facts, t.category_source AS source, c.name AS category
			 FROM transactions t LEFT JOIN categories c ON c.id = t.category_id WHERE t.id = ?`
		)
		.get(id) as { facts: string | null; source: string; category: string };

test('a match extracts Receipt facts and auto-applies a receipt-informed Category', async () => {
	const db = makeDb();
	const id = insertCharge(db);
	const { llm, prompts } = cannedLlm([FACTS_REPLY, '{"1": "Entertainment"}']);
	await runResolution(db, fakeSource([receipt({ snippet: 'AirPods Pro (2nd gen) $249.00' })]), llm, TODAY);

	expect(stateOf(db, id).s).toBe('matched');
	const txn = txnOf(db, id);
	expect(JSON.parse(txn.facts!).description).toBe('AirPods Pro (2nd gen)');
	expect(txn.category).toBe('Entertainment');
	expect(txn.source).toBe('llm+receipt');
	expect(prompts).toHaveLength(2); // one extraction, one categorization

	// a second pass has nothing new: matched rows are not re-searched or re-sent
	await runResolution(db, fakeSource([receipt()]), llm, TODAY);
	expect(prompts).toHaveLength(2);
});

test('prompt boundary: matched email + charge evidence + taxonomy only — never account identity', async () => {
	const db = makeDb();
	// plant lookalike leak values where a sloppy query could pick them up
	db.prepare("UPDATE accounts SET name = 'LEAKY-ACCOUNT-NAME', mask = '9999' WHERE id = 1").run();
	insertCharge(db);
	const { llm, prompts } = cannedLlm([FACTS_REPLY, '{"1": "Entertainment"}']);
	await runResolution(db, fakeSource([receipt({ snippet: 'AirPods Pro (2nd gen) $249.00' })]), llm, TODAY);

	expect(prompts[0]).toContain('AirPods Pro (2nd gen) $249.00'); // the matched email
	expect(prompts[1]).toContain('AMZN Mktp US'); // the charge evidence
	expect(prompts[1]).toContain('AirPods Pro (2nd gen)'); // the extracted facts
	for (const p of prompts) {
		expect(p).not.toContain('LEAKY-ACCOUNT-NAME');
		expect(p).not.toContain('9999');
	}
});

test('extraction failure leaves the match intact; categorization proceeds on bank evidence alone', async () => {
	const db = makeDb();
	const id = insertCharge(db);
	const { llm } = cannedLlm(['no json here', '{"1": "Shopping"}']);
	await runResolution(db, fakeSource([receipt()]), llm, TODAY);

	expect(stateOf(db, id).s).toBe('matched');
	const txn = txnOf(db, id);
	expect(txn.facts).toBeNull();
	expect(txn.category).toBe('Shopping');
	expect(txn.source).toBe('llm'); // no facts → bank-evidence source
});

test('LLM unavailable → charge stays matched on its current rung, sync never blocked', async () => {
	const db = makeDb();
	const id = insertCharge(db);
	const dead = async () => {
		throw new LlmUnavailable('no key');
	};
	await runResolution(db, fakeSource([receipt()]), dead, TODAY);

	expect(stateOf(db, id).s).toBe('matched');
	const txn = txnOf(db, id);
	expect(txn.facts).toBeNull();
	expect(txn.source).toBe('plaid');
	expect(txn.category).toBe('Other');
});

test('the retry window is a knob', async () => {
	const db = makeDb();
	db.prepare("UPDATE settings SET value = '30' WHERE key = 'receipt_retry_window_days'").run();
	const id = insertCharge(db, { date: '2026-06-10' }); // 24 days old
	const src = fakeSource([]);
	await runReceiptSearch(db, src, TODAY);
	expect(stateOf(db, id).s).toBe('pending');
	expect(src.searched).toHaveLength(1);
});
