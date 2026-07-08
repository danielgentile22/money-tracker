-- Phase 3 (ADR-0001 egress channel #3): enrolled Gmail Inboxes. Enrollment
-- metadata only — refresh tokens live in the Keychain, keyed per address.
CREATE TABLE inboxes (
  id INTEGER PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'expired')),
  enrolled_at TEXT NOT NULL DEFAULT (datetime('now'))
);
