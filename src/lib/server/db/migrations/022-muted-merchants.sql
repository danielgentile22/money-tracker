-- Muted merchants: owner said "not a bill" — detection skips them entirely, so
-- no series, Concerns, or Projection input ever exist. Merchant-keyed so the
-- mute outlives the wholesale series rebuild.
CREATE TABLE muted_merchants (
  merchant TEXT PRIMARY KEY,
  muted_at TEXT NOT NULL DEFAULT (date('now'))
);
