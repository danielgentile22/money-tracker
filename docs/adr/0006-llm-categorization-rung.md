# An LLM rung in the categorization ladder

**Status:** accepted — supersedes ADR-0005, amends ADR-0001 (channel 2) · **Date:** 2026-07-04

ADR-0005 rejected ML categorization when the alternatives were a trained classifier or
"LLM labels everything, per charge." The Monarch Session 1 grill (2026-07-04) revisited
that: categorization quality was capped by Plaid's guesses, and anything Plaid got wrong
that no Rule covered sat on `Other` until hand-corrected. We now run **one batched LLM
call per sync** over that sync's new Transactions, auto-applying with a visible `llm`
source. The ladder becomes:

**Rule → Correction → LLM → Plaid map → Other**

The Plaid map demotes to the offline fallback; it also remains the floor whenever the
LLM is unavailable (no key, offline, API error) — ingestion never blocks on a third
party.

## Considered options

- **Stay on Plaid map + Rules (status quo, ADR-0005).** Rejected — quality was capped by
  Plaid's guesses; everything Plaid got wrong and no Rule covered sat on `Other`.
- **A trained classifier on the owner's corrections.** Still rejected for ADR-0005's
  reasons: unauditable labels, training data of one household, no story for new merchants.
- **LLM labels everything, per charge.** Rejected in 2026-02 as needless egress and
  non-determinism; what changed is the *shape* — one batched call per sync, once at
  arrival, never re-labeling history — which keeps the determinism properties below.

## What ADR-0005 got right, kept

- **Rules and Corrections still outrank everything.** Anything the owner has taught the
  system is never second-guessed; the LLM only sees charges no Rule decided.
- **Determinism in the money path.** The model runs exactly once per charge, at
  arrival. Re-categorization sweeps after Rule/mapping edits stay deterministic and
  free: they respect `llm` rows the way they respect owner sources and never call the
  model. History is never re-labeled by a model.
- **Auditability.** Every assignment carries its source; `llm` rows are correctable
  exactly like any other, and a Correction can mint a Rule — the model's mistakes
  become standing automation.
- **No trained classifier.** Still rejected, for ADR-0005's reasons.

## What changed, and why

- "LLM labels everything" was rejected in 2026-02 as needless egress and
  non-determinism. Batched (one call per sync, Haiku-class, household volume) the cost
  is negligible, determinism is preserved by the once-at-arrival rule above, and the
  quality gap it closes is the foundation Budgets and reports roll up from.

## Egress (amends ADR-0001, channel 2)

The LLM channel now also carries **per-Transaction categorization evidence**: merchant
(raw bank string + normalized), amount, date, Plaid category hints + confidence,
account *type*, payment channel — plus the enabled Category taxonomy grouped by Group.
Still never: account numbers, balances, or identity. The prompt is built in one pure
function (`buildCategorizerPrompt` in `llm-categorizer.ts`); its inputs are the
boundary, testable by construction.

## Consequences

- `Transfer` is never offered to the model — transfer detection (the pairing pipeline)
  remains the only authority on Transfers. Disabled Categories are never offered.
- A malformed or out-of-taxonomy answer for a charge silently leaves it on the Plaid
  map rung; no retry loop, no review queue traffic.
- The model and key come from the existing proposer settings (`proposer_model`,
  Keychain `anthropic-api-key`) — credentials and model choice stay in one place.
- Historical Transactions are never batch-re-categorized by the LLM; history improves
  through Corrections and Rules as before.
