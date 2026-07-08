-- Enrich-then-categorize (ADR-0007): Receipt facts live on the Transaction,
-- one unified categorizer over all evidence. The proposer is gone.

-- Layer-1 output: extracted facts JSON alongside the raw Receipt reference.
ALTER TABLE transactions ADD COLUMN receipt_facts_json TEXT;

-- Widen category_source for the receipt-informed rung ('proposal' stays legal
-- on historical rows the owner approved). Same copy-through trick as 012/015.
ALTER TABLE transactions ADD COLUMN category_source_new TEXT
  CHECK (category_source_new IN ('plaid', 'rule', 'correction', 'proposal', 'llm', 'llm+receipt'));
UPDATE transactions SET category_source_new = category_source;
ALTER TABLE transactions DROP COLUMN category_source;
ALTER TABLE transactions RENAME COLUMN category_source_new TO category_source;

-- proposal-failed disappears as a state: the match itself still stands.
UPDATE transactions SET receipt_search_state = 'matched'
 WHERE receipt_search_state = 'proposal-failed';
ALTER TABLE transactions ADD COLUMN receipt_search_state_new TEXT
  CHECK (receipt_search_state_new IN ('pending', 'matched', 'exhausted'));
UPDATE transactions SET receipt_search_state_new = receipt_search_state;
ALTER TABLE transactions DROP COLUMN receipt_search_state;
ALTER TABLE transactions RENAME COLUMN receipt_search_state_new TO receipt_search_state;

-- Open Proposals close: their Receipt evidence lives on their Transactions via
-- the extractor backfill. The Review queue keeps Transfer pairing.
UPDATE review_items SET status = 'rejected', resolved_at = datetime('now')
 WHERE kind = 'proposal' AND status = 'open';
