-- p9-00: accounts that stop appearing in a Plaid item are marked inactive
-- rather than re-snapshotted as live forever. Net worth stops counting dead
-- accounts (closed at the bank, or deselected in a Link update); their history
-- freezes at its last real snapshot instead of compounding daily.
ALTER TABLE accounts ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
