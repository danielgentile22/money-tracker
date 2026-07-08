-- Monarch Session 2: Budgets v2. Per-month budget rows replace static Targets
-- (fill-forward: effective amount = row with greatest month <= viewed month).
-- Zero-amount rows are explicit "cleared from here on" markers.
CREATE TABLE budgets (
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  month TEXT NOT NULL, -- 'YYYY-MM'
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  PRIMARY KEY (category_id, month)
);

-- The Flex pool's per-month amount; not a Category, never joins Category queries.
CREATE TABLE flex_pool (
  month TEXT PRIMARY KEY, -- 'YYYY-MM'
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0)
);

-- Flex mode classification: fixed lines stay line-by-line, flexible pool together.
ALTER TABLE categories ADD COLUMN flex TEXT NOT NULL DEFAULT 'flexible'
  CHECK (flex IN ('fixed', 'flexible'));
-- Rollover: non-null month = rollover on, balance anchored at $0 that month.
ALTER TABLE categories ADD COLUMN rollover_anchor TEXT;

-- Seed classification by Group (grill decision 2026-07-04).
UPDATE categories SET flex = 'fixed' WHERE group_id IN (
  SELECT id FROM category_groups WHERE name IN ('Housing', 'Bills & Utilities', 'Financial')
);

-- Migrate: each Target becomes the current month's budget row, filling forward.
INSERT INTO budgets (category_id, month, amount_cents)
  SELECT category_id, strftime('%Y-%m', 'now', 'localtime'), monthly_cents FROM targets;
DROP TABLE targets;

INSERT INTO settings (key, value) VALUES ('budget_mode', 'category');
