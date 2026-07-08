-- Sign convention (owner-facing, flipped from Plaid's): negative = money out,
-- positive = money in. The flip happens once, in the Plaid source adapter.

CREATE TABLE transactions (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  plaid_transaction_id TEXT NOT NULL UNIQUE,
  date TEXT NOT NULL,              -- yyyy-mm-dd; Plaid's expected date while pending
  name TEXT NOT NULL,              -- raw payee string from the institution
  amount_cents INTEGER NOT NULL,
  pending INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_transactions_account_date ON transactions (account_id, date);
CREATE INDEX idx_transactions_date ON transactions (date);
