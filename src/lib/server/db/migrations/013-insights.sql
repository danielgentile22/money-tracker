-- Insights: stored LLM narrations over locally-computed figures (ADR-0001:
-- narration never invents a number; the digest hash records exactly what the
-- model saw). One row per kind+period — regeneration replaces.
CREATE TABLE insights (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('explain', 'summary')),
  period TEXT NOT NULL,          -- 'YYYY-MM'
  digest_hash TEXT NOT NULL,
  narration TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, period)
);
