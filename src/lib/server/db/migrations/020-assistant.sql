-- Session 5 Pass B: Assistant conversations, local-only (ADR-0001 — history
-- and feedback never leave the machine). tool_audit is the egress receipt:
-- every tool call and the exact payload returned to the model, per reply.
CREATE TABLE conversations (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  feedback TEXT CHECK (feedback IN ('up', 'down')),
  tool_audit TEXT,  -- JSON [{tool, input, result}], assistant rows only
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_messages_conversation ON messages (conversation_id);
