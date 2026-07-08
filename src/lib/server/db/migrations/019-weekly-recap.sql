-- Session 5: the Weekly Recap is a third insight kind. SQLite CHECK
-- constraints are immutable, so the table is rebuilt in place. Recap rows use
-- the ISO week's Monday ('YYYY-MM-DD') as period; monthly rows keep 'YYYY-MM'.
CREATE TABLE insights_new (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('explain', 'summary', 'recap')),
  period TEXT NOT NULL,
  digest_hash TEXT NOT NULL,
  narration TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, period)
);
INSERT INTO insights_new SELECT * FROM insights;
DROP TABLE insights;
ALTER TABLE insights_new RENAME TO insights;
