# Local-only data, with three deliberately-scoped egress channels

**Status:** accepted

All account data lives on the owner's device (local SQLite, local web UI, no cloud
server, no auth). The owner's hard constraint is zero risk of financial data leaking. We
accept exactly three channels where data leaves the device, each chosen on the owner's
explicit terms:

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

## Consequences

- A future reader sees a "local, private" app that nonetheless holds Gmail tokens and calls
  a cloud LLM. That is intentional and bounded to the three channels above — not scope creep.
- Gmail uses the restricted `gmail.readonly` scope on an unverified personal app (test-user
  cap, consent-screen warning). This avoids Google's verification/security assessment and is
  acceptable only because the app is single-owner.
- The LLM is never the source of a number or a silently-applied Category. It narrates
  locally-computed figures and proposes reviewed Categories. Non-determinism is kept out of
  the money-affecting paths.
