-- Concerns (Phase 2): Detector output with lifecycle. Identity is
-- detector:subject:period (UNIQUE) so re-fires upsert instead of duplicating.
-- figures/txn_ids are JSON — narration-ready for Phase 3's Insight layer.
CREATE TABLE concerns (
  id INTEGER PRIMARY KEY,
  detector TEXT NOT NULL,
  subject TEXT NOT NULL,
  period TEXT NOT NULL,              -- 'YYYY-MM' | 'YYYY-MM-DD' | 'ongoing'
  severity INTEGER NOT NULL,         -- 0–100, bucketed low/medium/high in code
  title TEXT NOT NULL,               -- deterministic one-line figures
  figures TEXT NOT NULL,             -- JSON object of detector-specific numbers
  txn_ids TEXT NOT NULL DEFAULT '[]',-- JSON array of backing transaction ids
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'dismissed', 'expired')),
  dismissed_bucket TEXT,             -- bucket at dismissal; resurrection gate
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (detector, subject, period)
);
