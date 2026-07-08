-- Recurring series (Phase 2): rebuilt wholesale on every detection run, so no
-- lifecycle columns — membership lives on the transaction for cheap ledger joins.
CREATE TABLE recurring_series (
  id INTEGER PRIMARY KEY,
  merchant TEXT NOT NULL,
  cadence TEXT NOT NULL CHECK (cadence IN ('weekly', 'monthly', 'annual')),
  typical_amount_cents INTEGER NOT NULL,  -- positive magnitude, median
  last_amount_cents INTEGER NOT NULL,     -- magnitude of newest occurrence
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

ALTER TABLE transactions ADD COLUMN recurring_series_id INTEGER REFERENCES recurring_series(id);
