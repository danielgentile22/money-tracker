-- Monarch Session 3: saved reports. A saved report is a named URL — the
-- config blob holds the page path plus its canonical query string (tab,
-- group-by, and the serialized FilterSet; presets stay relative by nature).
CREATE TABLE saved_reports (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  config TEXT NOT NULL, -- JSON: { path, query }
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
