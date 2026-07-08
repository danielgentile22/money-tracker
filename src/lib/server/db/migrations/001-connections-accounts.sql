-- Money amounts are INTEGER cents everywhere: exact equality is load-bearing
-- for Transfer pairing (ADR-0003); floats would make it flaky.

CREATE TABLE connections (
  id INTEGER PRIMARY KEY,
  institution_name TEXT NOT NULL,
  plaid_item_id TEXT NOT NULL UNIQUE,
  health TEXT NOT NULL DEFAULT 'healthy' CHECK (health IN ('healthy', 'degraded', 'broken')),
  sync_cursor TEXT,
  last_synced_at TEXT,
  last_sync_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  plaid_account_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,   -- Plaid: depository | credit | investment | loan | other
  subtype TEXT,         -- checking, savings, credit card, 529, brokerage...
  mask TEXT,
  current_balance_cents INTEGER,
  available_balance_cents INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
