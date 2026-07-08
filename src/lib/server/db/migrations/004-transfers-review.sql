-- Transfer flags (ADR-0003): excluded from spending/income/cash-flow semantics
-- (Phase 2 analytics consume these flags), still shown in the ledger.
ALTER TABLE transactions ADD COLUMN is_transfer INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transactions ADD COLUMN transfer_peer_id INTEGER REFERENCES transactions(id);
ALTER TABLE transactions ADD COLUMN is_saved INTEGER NOT NULL DEFAULT 0;

-- Generic review queue: Phase 1 uses kind 'transfer-ambiguity';
-- Phase 3 email Proposals plug in as a new kind without schema change.
CREATE TABLE review_items (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,   -- JSON, shape per kind
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES ('transfer_window_days', '4');
