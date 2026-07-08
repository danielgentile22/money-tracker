import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate';
import {
	appendMessage,
	createConversation,
	deleteConversation,
	getMessages,
	listConversations,
	setFeedback,
	titleFrom
} from './conversations';

function makeDb() {
	const db = new Database(':memory:');
	migrate(db);
	return db;
}

test('round-trip: create, append in order, list newest-updated first', () => {
	const db = makeDb();
	const a = createConversation(db, 'why was March expensive?');
	const b = createConversation(db, 'tax season research');
	expect(a.title).toBe('why was March expensive?');

	appendMessage(db, a.id, 'user', 'why was March expensive?');
	appendMessage(db, a.id, 'assistant', 'March had two large one-offs.', '[]');
	const msgs = getMessages(db, a.id);
	expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
	expect(msgs[1].tool_audit).toBe('[]');
	expect(getMessages(db, b.id)).toHaveLength(0); // threads never interleave

	// appending bumped a's updated_at past b's — SQLite datetime granularity is
	// one second, so force distinct timestamps instead of sleeping
	db.prepare("UPDATE conversations SET updated_at = datetime('now', '+1 second') WHERE id = ?").run(a.id);
	expect(listConversations(db).map((c) => c.id)).toEqual([a.id, b.id]);
});

test('titles truncate the first owner message', () => {
	expect(titleFrom('short question')).toBe('short question');
	expect(titleFrom('  x  '.repeat(40)).length).toBe(60);
	expect(titleFrom('x'.repeat(80)).endsWith('…')).toBe(true);
	expect(titleFrom('   ')).toBe('New conversation');
});

test('delete cascades to messages and leaves other threads intact', () => {
	const db = makeDb();
	const a = createConversation(db, 'doomed');
	const b = createConversation(db, 'survivor');
	appendMessage(db, a.id, 'user', 'hello');
	appendMessage(db, b.id, 'user', 'hi');
	deleteConversation(db, a.id);
	expect(listConversations(db).map((c) => c.id)).toEqual([b.id]);
	expect(db.prepare('SELECT COUNT(*) FROM messages').pluck().get()).toBe(1);
	expect(getMessages(db, b.id)).toHaveLength(1);
});

test('feedback: set, flip, clear — stored with the message', () => {
	const db = makeDb();
	const c = createConversation(db, 'q');
	const m = appendMessage(db, c.id, 'assistant', 'answer');
	setFeedback(db, m.id, 'up');
	expect(getMessages(db, c.id)[0].feedback).toBe('up');
	setFeedback(db, m.id, 'down');
	expect(getMessages(db, c.id)[0].feedback).toBe('down');
	setFeedback(db, m.id, null);
	expect(getMessages(db, c.id)[0].feedback).toBeNull();
});
