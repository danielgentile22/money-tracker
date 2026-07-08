-- Monarch Session 1, Pass A: Groups contain Categories; a Transaction has one
-- Category and any number of Tags; Rules may attach Tags. Also widens
-- category_source for Pass B's 'llm' rung (schema lands in one migration).

CREATE TABLE category_groups (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  emoji TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE categories ADD COLUMN group_id INTEGER REFERENCES category_groups(id);
ALTER TABLE categories ADD COLUMN emoji TEXT;
ALTER TABLE categories ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE categories ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;

-- A Rule may set a Category and/or attach Tags — category_id becomes nullable.
-- SQLite can't drop NOT NULL in place; rebuild the table.
CREATE TABLE rules_new (
  id INTEGER PRIMARY KEY,
  merchant TEXT NOT NULL,
  min_amount_cents INTEGER,
  max_amount_cents INTEGER,
  category_id INTEGER REFERENCES categories(id),
  provenance TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO rules_new SELECT id, merchant, min_amount_cents, max_amount_cents, category_id, provenance, created_at FROM rules;
DROP TABLE rules;
ALTER TABLE rules_new RENAME TO rules;

CREATE TABLE tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE transaction_tags (
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (transaction_id, tag_id)
);

CREATE TABLE rule_tags (
  rule_id INTEGER NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (rule_id, tag_id)
);

-- Widen the category_source CHECK for the LLM rung (same copy-through trick
-- as 012 — SQLite can't widen a CHECK in place).
ALTER TABLE transactions ADD COLUMN category_source_new TEXT
  CHECK (category_source_new IN ('plaid', 'rule', 'correction', 'proposal', 'llm'));
UPDATE transactions SET category_source_new = category_source;
ALTER TABLE transactions DROP COLUMN category_source;
ALTER TABLE transactions RENAME COLUMN category_source_new TO category_source;

-- Seed Monarch's 13 Groups and re-home the 26 seed Categories (decision log,
-- 2026-07-04 grill session).
INSERT INTO category_groups (name, emoji, sort_order) VALUES
  ('Income',             '💰', 1),
  ('Auto & Transport',   '🚗', 2),
  ('Housing',            '🏠', 3),
  ('Bills & Utilities',  '💡', 4),
  ('Food & Dining',      '🍽️', 5),
  ('Travel & Lifestyle', '✈️', 6),
  ('Shopping',           '🛍️', 7),
  ('Children',           '👶', 8),
  ('Education',          '🎓', 9),
  ('Gifts & Donations',  '🎁', 10),
  ('Health & Wellness',  '🏥', 11),
  ('Financial',          '🏦', 12),
  ('Other',              '📦', 13);

UPDATE categories SET group_id = (SELECT id FROM category_groups WHERE name = 'Income')
  WHERE name IN ('Income', 'Interest');
UPDATE categories SET group_id = (SELECT id FROM category_groups WHERE name = 'Auto & Transport')
  WHERE name = 'Transport';
UPDATE categories SET group_id = (SELECT id FROM category_groups WHERE name = 'Housing')
  WHERE name IN ('Rent & Utilities', 'Home');
UPDATE categories SET group_id = (SELECT id FROM category_groups WHERE name = 'Bills & Utilities')
  WHERE name IN ('Phone & Internet', 'Subscriptions');
UPDATE categories SET group_id = (SELECT id FROM category_groups WHERE name = 'Food & Dining')
  WHERE name IN ('Coffee', 'Groceries', 'Dining');
UPDATE categories SET group_id = (SELECT id FROM category_groups WHERE name = 'Travel & Lifestyle')
  WHERE name IN ('Travel', 'Entertainment', 'Personal Care');
UPDATE categories SET group_id = (SELECT id FROM category_groups WHERE name = 'Shopping')
  WHERE name IN ('Shopping', 'Cash');
UPDATE categories SET group_id = (SELECT id FROM category_groups WHERE name = 'Children')
  WHERE name IN ('Kids', 'Pets');
UPDATE categories SET group_id = (SELECT id FROM category_groups WHERE name = 'Education')
  WHERE name = 'Education';
UPDATE categories SET group_id = (SELECT id FROM category_groups WHERE name = 'Gifts & Donations')
  WHERE name IN ('Gifts', 'Charity');
UPDATE categories SET group_id = (SELECT id FROM category_groups WHERE name = 'Health & Wellness')
  WHERE name = 'Health';
UPDATE categories SET group_id = (SELECT id FROM category_groups WHERE name = 'Financial')
  WHERE name IN ('Insurance', 'Fees', 'Taxes', 'Transfer');
-- 'Other' plus any owner-created Category the seed doesn't know about.
UPDATE categories SET group_id = (SELECT id FROM category_groups WHERE name = 'Other')
  WHERE group_id IS NULL;

-- Stable within-Group ordering to start: seed insertion order.
UPDATE categories SET sort_order = (
  SELECT COUNT(*) FROM categories c2 WHERE c2.group_id = categories.group_id AND c2.id < categories.id
);
