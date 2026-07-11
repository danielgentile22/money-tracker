# Assistant: a bounded tool loop with a hard egress contract

**Status:** accepted (promotes the contract comment in `assistant.ts` to an ADR) · **Date:** 2026-07-11

The in-app Assistant answers questions about the owner's finances by running Claude in
a tool loop over the real engines (reports, ledger queries, budgets, digest). One
module (`src/lib/server/assistant.ts`) owns the whole exchange: it assembles the system
prompt, runs the loop, audits every tool payload, persists the messages, and returns
the reply. Two hard bounds shape it:

- **`MAX_TOOL_ITERATIONS = 6`** — one owner question can never turn into an unbounded
  number of API calls. If the model is still asking for tools at the cap, the loop ends
  and the model answers with what it has.
- **`TXN_LIST_CAP = 40`** — a broad question can't ship the entire ledger in one tool
  payload.

## Egress contract (ADR-0001, channel 2)

Tool payloads carry transaction descriptions, dates, amounts, and aggregates — the same
shapes the owner's own pages render. No tool can return account identifiers, account
balances, credentials, or email content; there is no account dimension in the tool
schema at all, so the model cannot even ask. The audit lives where the payloads are
built, testable by construction.

## Prompt injection posture

Receipt text is attacker-controlled: anyone who can email the owner can put
instructions in a receipt, and Receipt facts distilled from receipts (ADR-0007) sit on
transaction rows the Assistant's tools return. The posture is containment, not
detection:

- Injected text can only influence what the model *says and queries next* — every tool
  is read-only over local engines, so there is no action to hijack.
- The worst reachable outcome is bounded by the two caps and the egress contract: at
  most 6 tool calls of owner-visible shapes, never identifiers, balances, or
  credentials (which no tool can access, let alone return).
- No tool output is ever executed, rendered as HTML, or fed to another channel.

## Considered options

- **No cap, trust the model to stop.** Rejected — an adversarial receipt or a
  pathological question could loop the paid API indefinitely.
- **Single-shot (no tool loop): stuff a digest into one prompt.** Rejected — that is the
  narration feature, which already exists; the Assistant's value is targeted follow-up
  queries, which need tools.
- **Write-capable tools (corrections, rules) in the loop.** Rejected for v1 — combined
  with attacker-controlled receipt text in the context, write tools turn prompt
  injection from a nuisance into data corruption. Revisit only with an explicit
  confirm-in-UI step on every write.
