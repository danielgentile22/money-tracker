-- Approved Proposals write category_source 'proposal' (story 18: "why is this
-- Coffee?" stays answerable — the source names the pipeline, receipt_json on
-- the row is the evidence). SQLite can't widen a CHECK in place; copy the
-- column through a new one instead of rebuilding the table.
ALTER TABLE transactions ADD COLUMN category_source_new TEXT
  CHECK (category_source_new IN ('plaid', 'rule', 'correction', 'proposal'));
UPDATE transactions SET category_source_new = category_source;
ALTER TABLE transactions DROP COLUMN category_source;
ALTER TABLE transactions RENAME COLUMN category_source_new TO category_source;
