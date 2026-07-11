# Categorization: Plaid category + rules table, no custom ML classifier

**Status:** superseded by ADR-0006 · **Date:** 2026-07-04

The obvious path for "learn my categories from my corrections" is a trained ML classifier. We
deliberately reject that in favor of a deterministic ladder: **Plaid category → Rules table →
LLM+email for Unresolved charges only**. A Correction mints or updates a Rule; no model is
trained.

## Why rules, not ML

- **Personal spend is dominated by recurring merchants** (~100–300 that repeat). A Rules table
  nails those exactly and instantly; ML would spend its budget generalizing to a thin tail the
  owner corrects once anyway.
- **Plaid's category is already the ML generalizer** for merchants never seen before — trained
  on millions of transactions. Building our own classifier is redundant with it.
- **Money needs auditable, stable labels.** Rules answer "why is this Coffee?" with "you said
  so on 2026-03-01." Retraining an ML model can silently reclassify past data and quietly
  corrupt Projections — non-determinism in the money path is a bug.
- **Cost:** a Rules table is ~50 lines; a classifier is a subsystem (training data, retraining
  triggers, versioning, eval) maintained forever.

## Considered options

- **Custom ML classifier trained on Corrections** — rejected for the reasons above.
- **LLM labels everything** — rejected: needless egress and non-determinism; Plaid + Rules
  already cover the common case.

## Consequences

- The one honest weak spot — ambiguous same-merchant charges (Amazon, Venmo, Zelle) — is
  handled by **email-receipt lookup** (read the actual itemization), not by a classifier
  guessing from the amount. Those land as reviewed Proposals (see ADR-0001).
- A future contributor may propose "add ML categorization." This ADR records why not.
