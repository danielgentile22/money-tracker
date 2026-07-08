-- One balance point per Account per day. UNIQUE makes same-day re-syncs
-- update in place (Snapshot idempotency). estimated=1 marks reconstructed
-- pre-day-1 history (cash Accounts only — CONTEXT.md Snapshot entry).
CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  balance_cents INTEGER NOT NULL,
  estimated INTEGER NOT NULL DEFAULT 0,
  UNIQUE (account_id, date)
);
