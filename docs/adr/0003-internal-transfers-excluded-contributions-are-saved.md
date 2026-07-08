# Internal transfers excluded from spending/income; contributions count as saved

**Status:** accepted

With accounts across multiple institutions and account types, money constantly moves *between the owner's own
accounts*: checking→savings, credit-card payments, and savings/investment/529 contributions.
Treating those as income or expense corrupts every analytic — spending double-counts (card
charges *and* the card payment), cash flow swings on paycheck-to-savings moves, and the
savings-rate is meaningless.

**Decision:**
- Detect internal **Transfers** by pairing opposite-sign legs across the owner's Accounts
  within a date window, plus Plaid's transfer signal.
- **Exclude** Transfers from spending, income, and cash-flow — but still show them in the
  ledger. A credit-card payment is a Transfer, not an expense; the real expenses are the
  individual card charges.
- A contribution into an asset Account (savings, investment, 529) counts as **saved** in the
  savings-rate, not as spending and not as income.
- Ambiguous or unpaired candidates go to the same one-tap **review queue** as email Proposals.

## Considered options

- **Trust only Plaid's transfer flag** — rejected: misses cross-account pairs Plaid doesn't
  flag, letting double-counting leak into every number.

## Consequences

- Savings-rate and all Projections depend on this classification; a change here retroactively
  moves historical figures, so the rule is deliberately fixed and documented here.
- A future reader will wonder why credit-card payments don't appear in spending and why 529
  contributions read as saved. This is why.
