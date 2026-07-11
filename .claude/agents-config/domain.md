# Domain docs

Single-context repo:

- `CONTEXT.md` (repo root) — the domain glossary. Use its terms exactly
  (Account, Connection, Transaction, Transfer, Merchant, Category, Rule,
  Correction, Unresolved charge, Snapshot, Inbox, Receipt, Proposal, Detector,
  Concern, Target, Insight, Projection) and respect its _Avoid_ lists.
- `docs/adr/` — accepted architectural decisions, in
  [MADR](https://adr.github.io/madr/) format (YAML frontmatter with status/date,
  Context and Problem Statement, Considered Options, Decision Outcome,
  Consequences). Respect them; propose a new ADR in the same format rather than
  silently contradicting one.
- `PLAN.md` — the locked v1 plan and 3-phase build sequence.
