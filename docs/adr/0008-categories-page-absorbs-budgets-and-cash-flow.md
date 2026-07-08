# Categories page absorbs Budgets and Cash Flow, month-first

The owner's primary loop is observing spending per Category and auditing miscategorized
Transactions — spread today across Budgets, Cash Flow, Reports, and a category manager
buried in Settings. We consolidated: one **Categories** page (`/categories`) carries the
month's Sankey, a ranked group→category list with hard budget lines, per-category
drill-down into a full Ledger, and all category/group management. `/budgets` and
`/cash-flow` redirect there. (Grill session 2026-07-06, second session.)

Two deliberate deviations a future reader would otherwise "fix":

- **Month-first, not Filter-set-first.** Every other analysis view speaks the Filter set;
  this page instead has a single month cursor and no filter bar. Budgets are stored per
  `(Category, month)` with fill-forward — an arbitrary date range renders the budget
  column meaningless, and the budget column is the centerpiece. Arbitrary ranges remain
  the Reports page's job.
- **Flex mode retired, not migrated.** Budget mode (Category vs Flex) and the Flex pool
  answer "did total variable spending stay under one cap?" — the owner's question is
  per-category performance, the thing Flex mode deliberately hides. The flex columns and
  stored configuration remain in the DB but drive nothing.

## Considered options

- Merge Recurring in too (owner's first instinct) — rejected: Recurring series are keyed
  on Merchant, not Category, and their states derive from *today*, which a month cursor
  contradicts. Recurring stays a standalone page; recurring-ness is an attribute a
  Transaction has in addition to its Category.
- A literal "Recurring" Category re-homing rent/Netflix/etc. — rejected: it would erase
  the category identity of the largest charges and defeat the per-category breakdown.
- Filter-set-first page with the budget column appearing only on exact-month ranges —
  rejected: the page's core feature would vanish whenever the date picker moved.

## Consequences

- The transactions Ledger (rows, detail, multi-select, corrections) is extracted from the
  Transactions page into one shared surface used by the Categories drill-down — see
  "Ledger" and "Month cursor" in CONTEXT.md for the navigation invariants.
- Deleting a Category is always re-home-then-remove (one gesture); "disable" is no longer
  user-facing.
- Reports is untouched and awaiting its own rework (future: AI-assisted reports); its
  inline transaction list stays as-is until then.
