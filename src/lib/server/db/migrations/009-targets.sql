-- Budgets (Phase 2): one optional monthly Target per Category, no rollover,
-- no zero-based ceremony (PLAN.md). Actuals come from the analytics module.
CREATE TABLE targets (
  category_id INTEGER PRIMARY KEY REFERENCES categories(id) ON DELETE CASCADE,
  monthly_cents INTEGER NOT NULL CHECK (monthly_cents > 0)
);
