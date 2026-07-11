# Plaid as the data aggregator; build, don't buy

**Status:** accepted · **Date:** 2026-07-04

The owner wants to build and own a private, local app (see ADR-0001), pulling all accounts
across depository/credit (credit card, debit, checking, savings) and investment (brokerage +
529). The deciding factor is that the aggregator must reach the **investment and 529
data**, not just the cash/credit accounts.

**Decision:** use **Plaid** (free Trial plan — 10 Items, real production data — plenty for a
household). It is the only DIY aggregator API that covers all accounts, including brokerage
investments and 529s (Investments product), over OAuth with no credential sharing.

## Considered options

- **Teller.io** — free, cleanest developer API. *Rejected:* depository + credit
  only; cannot see brokerage investment accounts or 529s. Fatal for this account mix.
- **SimpleFIN Bridge** ($15/yr) — dead-simple. *Rejected:* weak on investment
  holdings (balances, not positions), once-daily, ~90-day history — thin for the investment side.
- **Manual CSV** — many institutions killed QFX/Direct Connect; only CSV/Excel export remains.
  Free and truly zero-egress, but heavy recurring toil across all accounts and no holdings
  detail. Kept only as the theoretical zero-egress fallback, not the automation path.
- **Buy off-the-shelf** (Monarch ~$100/yr, Copilot, Lunch Money, Actual Budget + SimpleFIN) —
  would solve ingestion with zero build. *Rejected:* the owner wants to build and own a local,
  private app, and none offer the custom rules + email-receipt + AI-narration pipeline wanted.

## Consequences

- Plaid inherently routes bank data through its servers — accepted as egress channel #1 in
  ADR-0001.
- institutions migrate their APIs and will disconnect existing Items eventually;
  Connection health / re-link is a first-class UI concern.
