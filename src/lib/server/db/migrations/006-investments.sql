-- PLAN.md: inside investment accounts, activity is invisible. Internal investment activity
-- (buys, sells, dividends, reinvestments, fees) is stored but flagged — never
-- rendered as spending, never in income/expense semantics, never paired as a
-- Transfer. External legs (contributions, withdrawals) stay unflagged so p1-06
-- pairing sees them.
ALTER TABLE transactions ADD COLUMN is_investment_activity INTEGER NOT NULL DEFAULT 0;
