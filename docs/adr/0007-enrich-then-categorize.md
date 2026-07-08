# Enrich then categorize: Receipt facts on the row, one categorizer

**Status:** accepted — amends ADR-0006 and ADR-0001 (channel 2); retires the proposer (ADR-0005 third rung)

The Gmail scan used to end in a Review-queue Proposal, and the batched LLM rung never saw
a Receipt even when one was matched. Receipt emails arrive days after the charge posts, so
the better evidence landed after ADR-0006's once-per-charge model call and changed nothing.
The owner's framing (2026-07-05): enrichment should put data on every Transaction; a
separate categorizer should use all data available.

The pipeline is now two independent layers, each covering every Transaction uniformly:

- **Layer 1 — enrichment** (`receipt-extractor.ts`): a matched Receipt is distilled into
  structured facts stored on the row (`receipt_facts_json`): a one-line description of
  what the purchase was for, line items when shown, the vendor's own name. Owner-visible
  on the ledger and Transaction detail, not just model fodder.
- **Layer 2 — categorization** (`llm-categorizer.ts`, unified): one categorizer consuming
  bank evidence plus Receipt facts when present. Batched at arrival as before; re-run on
  a single Transaction when its Receipt matches. Receipt-informed assignments auto-apply
  with the distinct source `llm+receipt`.

The ladder: **Rule → Correction → LLM (`llm` / `llm+receipt`) → Plaid map → Other.**

## Amendments

- **ADR-0006 "exactly once per charge" becomes "at most twice":** once at arrival, once
  when a Receipt matches. Deterministic sweeps after Rule/mapping edits still never call
  the model; a re-run may only replace assignments whose source is the Plaid map or a
  model rung. Rules, Corrections, and historical approved Proposals are never touched.
- **ADR-0001 channel 2:** the LLM channel now carries the matched Receipt's content for
  extraction and its extracted facts for the second categorization run. It already
  carried the full matched email for proposals, so net egress is unchanged in kind.

## The proposer is gone

- No more Category Proposals; the Review queue is Transfer pairing only. Open Proposals
  were closed by migration 021; their Receipt evidence survives on their Transactions via
  the full-scan extractor backfill. `proposal-failed` disappeared as a state — extraction
  failure leaves facts empty and the match standing.
- The owner's word remains final: a Correction on a model row works exactly as before and
  can mint a Rule. `category_source = 'proposal'` survives on historical rows.

## Consequences

- Both layers fail soft (empty facts / unchanged Category); ingestion never blocks on
  Gmail or the Anthropic API.
- Strict parsing everywhere: anything but a clean, in-schema reply is a null/no-op,
  never a guess.
- The full scan re-extracts and re-categorizes all history (matched rows included); the
  last-month scan revisits recent unmatched charges; the per-sync auto scan covers new
  arrivals and the retry window.
- Model choice stays on the `proposer_model` setting (one knob, legacy name).
