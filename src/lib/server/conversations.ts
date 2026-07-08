import type { Database } from 'better-sqlite3';

// The Assistant's thread store. Everything here is local SQLite — history,
// feedback, and tool audits never leave the machine (ADR-0001).

export type Conversation = { id: number; title: string; created_at: string; updated_at: string };

export type Feedback = 'up' | 'down' | null;

export type Message = {
	id: number;
	conversation_id: number;
	role: 'user' | 'assistant';
	content: string;
	feedback: Feedback;
	tool_audit: string | null; // JSON [{tool, input, result}]
	created_at: string;
};

/** Thread titles are a truncation of the first owner message — no LLM call spent on titling. */
export function titleFrom(text: string): string {
	const t = text.trim().replace(/\s+/g, ' ');
	return t.length <= 60 ? t || 'New conversation' : `${t.slice(0, 59)}…`;
}

export function listConversations(db: Database): Conversation[] {
	return db
		.prepare('SELECT * FROM conversations ORDER BY updated_at DESC, id DESC')
		.all() as Conversation[];
}

export function createConversation(db: Database, title: string): Conversation {
	const id = db.prepare('INSERT INTO conversations (title) VALUES (?)').run(titleFrom(title))
		.lastInsertRowid as number;
	return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Conversation;
}

/** Explicit cascade — correct with or without the foreign_keys pragma. */
export function deleteConversation(db: Database, id: number): void {
	db.transaction(() => {
		db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
		db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
	})();
}

export function appendMessage(
	db: Database,
	conversationId: number,
	role: 'user' | 'assistant',
	content: string,
	toolAudit: string | null = null
): Message {
	const id = db
		.prepare('INSERT INTO messages (conversation_id, role, content, tool_audit) VALUES (?, ?, ?, ?)')
		.run(conversationId, role, content, toolAudit).lastInsertRowid as number;
	db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(
		conversationId
	);
	return db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Message;
}

export function getMessages(db: Database, conversationId: number): Message[] {
	return db
		.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id')
		.all(conversationId) as Message[];
}

/** Thumbs on an assistant reply — stored with the message, sent nowhere. */
export function setFeedback(db: Database, messageId: number, feedback: Feedback): void {
	db.prepare('UPDATE messages SET feedback = ? WHERE id = ?').run(feedback, messageId);
}
