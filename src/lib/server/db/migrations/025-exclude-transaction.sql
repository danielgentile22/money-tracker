-- Manual per-Transaction exclusion: keeps a row out of every aggregate
-- (totals, graphs, budgets, detectors) the same way is_transfer does, while
-- leaving it in the ledger list so it can be un-excluded, and leaving it in
-- balance math so Account balances still reconcile with the bank.
ALTER TABLE transactions ADD COLUMN is_excluded INTEGER NOT NULL DEFAULT 0;
