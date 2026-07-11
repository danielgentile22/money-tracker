---
status: accepted (promotes the contract comment in `assistant.ts` to an ADR)
date: 2026-07-11
---

# Assistant: a bounded tool loop with a hard egress contract

## Context and Problem Statement

The in-app Assistant answers questions about the owner's finances by running Claude in a
tool loop over the real engines (reports, ledger queries, budgets, digest). One module
(`src/lib/server/assistant.ts`) owns the whole exchange: it assembles the system prompt,
runs the loop, audits every tool payload, persists the messages, and returns the reply.
How should the loop be bounded, and what may tool payloads carry off-device?

## Considered Options

* Bounded read-only tool loop with a hard egress contract
* No cap, trust the model to stop
* Single-shot (no tool loop): stuff a digest into one prompt
* Write-capable tools (corrections, rules) in the loop

## Decision Outcome

Chosen option: a bounded, read-only tool loop. Two hard bounds shape it:

* **`MAX_TOOL_ITERATIONS = 6`** — one owner question can never turn into an unbounded
  number of API calls. Each iteration is one model call that may request several tool calls
  (all executed locally), so the bound is 6 model calls plus one final "answer with what
  you have" call if the model is still asking for tools at the cap.
* **`TXN_LIST_CAP = 40`** — a broad question can't ship the entire ledger in one tool
  payload.

### Consequences

* Good, because the worst reachable outcome of prompt injection is bounded by the
  iteration cap and the egress contract (see below).
* Neutral, because a question needing more than 6 rounds of tool calls gets a best-effort
  answer from what was gathered.

## Pros and Cons of the Options

### No cap, trust the model to stop

Rejected — an adversarial receipt or a pathological question could loop the paid API
indefinitely.

### Single-shot (no tool loop): stuff a digest into one prompt

Rejected — that is the narration feature, which already exists; the Assistant's value is
targeted follow-up queries, which need tools.

### Write-capable tools (corrections, rules) in the loop

Rejected for v1 — combined with attacker-controlled receipt text in the context, write
tools turn prompt injection from a nuisance into data corruption. Revisit only with an
explicit confirm-in-UI step on every write.

## More Information

### Egress contract (ADR-0001, channel 2)

Tool payloads carry transaction descriptions, dates, amounts, and aggregates — the same
shapes the owner's own pages render. No tool can return account identifiers, account
balances, credentials, or email content; there is no account dimension in the tool schema
at all, so the model cannot even ask. The audit lives where the payloads are built,
testable by construction.

### Prompt injection posture

Receipt text is attacker-controlled: anyone who can email the owner can put instructions
in a receipt, and Receipt facts distilled from receipts
([ADR-0007](0007-enrich-then-categorize.md)) sit on transaction rows the Assistant's tools
return. The posture is containment, not detection:

* Injected text can only influence what the model *says and queries next* — every tool is
  read-only over local engines, so there is no action to hijack.
* The worst reachable outcome is bounded by the iteration cap and the egress contract: a
  handful of tool payloads of owner-visible shapes, never identifiers, balances, or
  credentials (which no tool can access, let alone return).
* No tool output is ever executed, rendered as HTML, or fed to another channel.
