CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

-- Keys are Plaid personal_finance_category values: detailed (specific) or
-- primary (fallback). Lookup order in the categorizer: detailed, then primary.
CREATE TABLE plaid_category_map (
  plaid_key TEXT PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id)
);

CREATE TABLE rules (
  id INTEGER PRIMARY KEY,
  merchant TEXT NOT NULL,            -- normalized Merchant, matched case-insensitively
  min_amount_cents INTEGER,          -- optional range, absolute cents
  max_amount_cents INTEGER,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  provenance TEXT,                   -- e.g. "Correction on BLUE BOTTLE, 2026-07-04"
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE transactions ADD COLUMN merchant TEXT;
ALTER TABLE transactions ADD COLUMN plaid_merchant_name TEXT;
ALTER TABLE transactions ADD COLUMN category_id INTEGER REFERENCES categories(id);
ALTER TABLE transactions ADD COLUMN category_source TEXT
  CHECK (category_source IN ('plaid', 'rule', 'correction'));
ALTER TABLE transactions ADD COLUMN plaid_category_primary TEXT;
ALTER TABLE transactions ADD COLUMN plaid_category_detailed TEXT;
ALTER TABLE transactions ADD COLUMN plaid_confidence TEXT;
ALTER TABLE transactions ADD COLUMN unresolved INTEGER NOT NULL DEFAULT 0;

-- Seed taxonomy: the owner's ~25 names (editable in Settings, p1-10).
INSERT INTO categories (name) VALUES
  ('Income'), ('Transfer'), ('Coffee'), ('Groceries'), ('Dining'), ('Kids'),
  ('Shopping'), ('Entertainment'), ('Subscriptions'), ('Transport'), ('Travel'),
  ('Health'), ('Personal Care'), ('Home'), ('Rent & Utilities'), ('Phone & Internet'),
  ('Insurance'), ('Fees'), ('Interest'), ('Education'), ('Gifts'), ('Charity'),
  ('Pets'), ('Taxes'), ('Cash'), ('Other');

-- Primary-level fallbacks (all 16 Plaid primaries covered).
INSERT INTO plaid_category_map (plaid_key, category_id) VALUES
  ('INCOME',                    (SELECT id FROM categories WHERE name = 'Income')),
  ('TRANSFER_IN',               (SELECT id FROM categories WHERE name = 'Transfer')),
  ('TRANSFER_OUT',              (SELECT id FROM categories WHERE name = 'Transfer')),
  ('LOAN_PAYMENTS',             (SELECT id FROM categories WHERE name = 'Other')),
  ('BANK_FEES',                 (SELECT id FROM categories WHERE name = 'Fees')),
  ('ENTERTAINMENT',             (SELECT id FROM categories WHERE name = 'Entertainment')),
  ('FOOD_AND_DRINK',            (SELECT id FROM categories WHERE name = 'Dining')),
  ('GENERAL_MERCHANDISE',       (SELECT id FROM categories WHERE name = 'Shopping')),
  ('HOME_IMPROVEMENT',          (SELECT id FROM categories WHERE name = 'Home')),
  ('MEDICAL',                   (SELECT id FROM categories WHERE name = 'Health')),
  ('PERSONAL_CARE',             (SELECT id FROM categories WHERE name = 'Personal Care')),
  ('GENERAL_SERVICES',          (SELECT id FROM categories WHERE name = 'Other')),
  ('GOVERNMENT_AND_NON_PROFIT', (SELECT id FROM categories WHERE name = 'Charity')),
  ('TRANSPORTATION',            (SELECT id FROM categories WHERE name = 'Transport')),
  ('TRAVEL',                    (SELECT id FROM categories WHERE name = 'Travel')),
  ('RENT_AND_UTILITIES',        (SELECT id FROM categories WHERE name = 'Rent & Utilities'));

-- Detailed overrides where the owner's taxonomy is finer than a primary.
-- Unknown detailed values fall back to their primary by design; the p1-11
-- sanity pass and the p1-10 mapping editor tune this list against real data.
INSERT INTO plaid_category_map (plaid_key, category_id) VALUES
  ('FOOD_AND_DRINK_COFFEE',                  (SELECT id FROM categories WHERE name = 'Coffee')),
  ('FOOD_AND_DRINK_GROCERIES',               (SELECT id FROM categories WHERE name = 'Groceries')),
  ('BANK_FEES_INTEREST_CHARGE',              (SELECT id FROM categories WHERE name = 'Interest')),
  ('LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',      (SELECT id FROM categories WHERE name = 'Transfer')),
  ('LOAN_PAYMENTS_MORTGAGE_PAYMENT',         (SELECT id FROM categories WHERE name = 'Home')),
  ('MEDICAL_VETERINARY_SERVICES',            (SELECT id FROM categories WHERE name = 'Pets')),
  ('GENERAL_MERCHANDISE_PET_SUPPLIES',       (SELECT id FROM categories WHERE name = 'Pets')),
  ('GENERAL_SERVICES_EDUCATION',             (SELECT id FROM categories WHERE name = 'Education')),
  ('GENERAL_SERVICES_INSURANCE',             (SELECT id FROM categories WHERE name = 'Insurance')),
  ('GENERAL_SERVICES_CHILDCARE',             (SELECT id FROM categories WHERE name = 'Kids')),
  ('GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT',  (SELECT id FROM categories WHERE name = 'Taxes')),
  ('RENT_AND_UTILITIES_INTERNET_AND_CABLE',  (SELECT id FROM categories WHERE name = 'Phone & Internet')),
  ('RENT_AND_UTILITIES_TELEPHONE',           (SELECT id FROM categories WHERE name = 'Phone & Internet'));
