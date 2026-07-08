-- Monarch Session 1, Pass B: Plaid's payment channel joins the stored evidence
-- so the LLM categorization rung can see it (ADR-0006 scoped evidence).
ALTER TABLE transactions ADD COLUMN payment_channel TEXT;
