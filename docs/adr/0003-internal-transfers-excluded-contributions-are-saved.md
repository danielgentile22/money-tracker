---
status: accepted
date: 2026-07-04
---

# Internal transfers excluded from spending/income; contributions count as saved

## Context and Problem Statement

With accounts across multiple institutions and account types, money constantly moves
*between the owner's own accounts*: checking→savings, credit-card payments, and
savings/investment/529 contributions. Treating those as income or expense corrupts every
analytic — spending double-counts (card charges *and* the card payment), cash flow swings
on paycheck-to-savings moves, and the savings-rate is meaningless. How should internal
transfers be classified?

## Considered Options

* Detect transfer pairs ourselves (opposite-sign legs + Plaid signal), exclude from analytics
* Trust only Plaid's transfer flag

## Decision Outcome

Chosen option: detect and exclude transfers ourselves.

* Detect internal **Transfers** by pairing opposite-sign legs across the owner's Accounts
  within a date window, plus Plaid's transfer signal.
* **Exclude** Transfers from spending, income, and cash-flow — but still show them in the
  ledger. A credit-card payment is a Transfer, not an expense; the real expenses are the
  individual card charges.
* A contribution into an asset Account (savings, investment, 529) counts as **saved** in
  the savings-rate, not as spending and not as income.
* Ambiguous or unpaired candidates go to the same one-tap **review queue** as email
  Proposals.

"Trust only Plaid's transfer flag" was rejected: it misses cross-account pairs Plaid
doesn't flag, letting double-counting leak into every number.

### Consequences

* Good, because analytics stop double-counting card payments and paycheck-to-savings moves.
* Neutral, because a future reader will wonder why credit-card payments don't appear in
  spending and why 529 contributions read as saved. This is why.
* Bad (constraint), because savings-rate and all Projections depend on this classification;
  a change here retroactively moves historical figures, so the rule is deliberately fixed
  and documented here.
