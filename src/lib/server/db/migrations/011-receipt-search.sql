-- Phase 3 receipt lookup (p3-02): search-state machine on Transactions.
-- NULL = never considered; matched rows hold the Receipt candidate JSON for
-- the proposer (p3-03), which may push a row to proposal-failed.
ALTER TABLE transactions ADD COLUMN receipt_search_state TEXT
  CHECK (receipt_search_state IN ('pending', 'matched', 'exhausted', 'proposal-failed'));
ALTER TABLE transactions ADD COLUMN receipt_json TEXT;

-- Receipts arrive within days or not at all: one knob bounds both the Gmail
-- query date window and the retry horizon (stop searching at this age).
INSERT INTO settings (key, value) VALUES ('receipt_retry_window_days', '14');
-- Matcher acceptance threshold — errs toward no-match over wrong-match.
INSERT INTO settings (key, value) VALUES ('receipt_match_min_score', '4');
