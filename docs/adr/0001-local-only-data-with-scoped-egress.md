---
status: accepted
date: 2026-07-04
---

# Local-only data, with three deliberately-scoped egress channels

## Context and Problem Statement

All account data lives on the owner's device (local SQLite, local web UI, no cloud
server, no auth). The owner's hard constraint is zero risk of financial data leaking.
Which channels, if any, may financial data leave the device through?

## Considered Options

* Exactly three scoped egress channels: Plaid ingestion, cloud LLM digest, in-app Gmail read-only
* Truly zero egress: manual CSV/OFX import, no cloud LLM, no Gmail
* Local-only models for the insight layer
* A session-bound MCP agent for email lookup instead of app-owned OAuth
* More channels later (webhooks, cloud backup, mobile sync)

## Decision Outcome

Chosen option: "Exactly three scoped egress channels", each on the owner's explicit terms:

1. **Plaid ingestion** — automatic pulling inherently routes bank data through Plaid's
   servers. Accepted over truly-zero-egress manual CSV because the owner wants automatic
   sync across all accounts.
2. **Cloud LLM (Claude) for the narrative Insight layer only** — labeling, corrections,
   and Projections are computed locally and deterministically; only a *digest* (category
   totals, trends, top merchants — never account numbers, balances, or identity) is sent
   to Claude to narrate. Local-only models were rejected as too weak for the insight
   quality wanted.
3. **In-app Gmail read-only access to resolve Unresolved charges** — the app owns OAuth to
   several Gmail Inboxes (chosen over a session-bound MCP agent so multiple
   Inboxes can be enrolled). Searches are narrow (amount + date + merchant); only the
   matched Receipt snippet reaches Claude. Email-derived Categories land in a review queue
   as Proposals and never auto-apply — fuzzy matching must not silently corrupt Categories
   or Projections.

### Consequences

* Good, because the LLM is never the source of a number or a silently-applied Category. It
  narrates locally-computed figures and proposes reviewed Categories. Non-determinism is
  kept out of the money-affecting paths.
* Neutral, because a future reader sees a "local, private" app that nonetheless holds Gmail
  tokens and calls a cloud LLM. That is intentional and bounded to the three channels above
  — not scope creep.
* Bad, because Gmail uses the restricted `gmail.readonly` scope on an unverified personal
  app (test-user cap, consent-screen warning). This avoids Google's verification/security
  assessment and is acceptable only because the app is single-owner.

## Pros and Cons of the Options

### Truly zero egress: manual CSV/OFX import, no cloud LLM, no Gmail

Rejected — the owner wants automatic sync across all accounts, and hand-importing a dozen
accounts monthly is the failure mode that kills personal finance tools.

### Local-only models for the insight layer

Rejected as too weak for the insight quality wanted; the compromise is that only an
anonymized digest crosses the wire.

### A session-bound MCP agent for email lookup instead of app-owned OAuth

Rejected because multiple Gmail Inboxes need standing enrollment, not per-session grants.

### More channels later (webhooks, cloud backup, mobile sync)

Explicitly out: the contract is *exactly three*, and any fourth channel requires
superseding this ADR.
