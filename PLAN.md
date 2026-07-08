# Money Tracker — Locked Plan

A local-first personal finance app for a household's bank accounts
(including investment and 529 education accounts). Pulls data automatically via Plaid,
categorizes transactions with a rules ladder, and surfaces analytics, projections, and
AI-narrated insights — all on the owner's machine.

Terminology: see [CONTEXT.md](./CONTEXT.md). Decisions: see [docs/adr/](./docs/adr/).

**Status (2026-07-04): all three phases built** — 156 tests green, all 9 surfaces live on
real production data. v1 waits on two owner gates: p3-07 (cloud go-live + sign-off) and
p2-13 (Phase 2 acceptance).

## Accounts — as linked in production

- **Depository/credit accounts** — credit card, debit, checking, savings → `/transactions/sync`
- **Investment + 529 education accounts** can ride along on the same institution login,
  **balances only** — some institutions supply no investments transactions; the sync engine
  skips that product gracefully. One Connection covers the whole mix.

## Ingestion

- **Plaid**, free Trial plan (10 Items — plenty for a household). Products: Transactions +
  Investments. OAuth link flow, done once per Connection.
  Why Plaid over Teller / SimpleFIN / manual CSV / off-the-shelf apps: see ADR-0004.
- **Sync:** on app launch + a manual Refresh button. Cursor-based incremental. Pull max
  history at first link (as far back as the institution provides). **No daemon:** everything timed fires
  as on-launch catch-up (sync runs; first launch of a new month generates the monthly
  Insight). Scheduled daily pull deferred — a launchd plist can be added later if wanted.
- **Balances:** record a per-Account **Snapshot** at every sync (feeds net worth + 529
  projection). Pre-day-1 history reconstructed backwards through Transactions for cash
  Accounts only, marked estimated on charts; investment history starts at day 1.
- ⚠️ institutions migrate their APIs and **will break a Connection eventually** —
  Connection health is a first-class UI surface (see below).

## Categorization ladder

**Taxonomy:** the owner's own Category list (~25 seed names like Coffee, Groceries, Kids —
editable in Settings), populated via a mapping table from Plaid's detailed categories. Rules,
Targets, charts, and LLM Proposals use only the owner's names; Corrections can add new
Categories (e.g. "Gift") on the fly.

Each rung handles only what the one above couldn't:

1. **Plaid category** — the free, pre-trained ML generalizer for merchants never seen before,
   translated through the mapping table.
2. **Rules table** — the owner's personalization. A Rule maps a normalized Merchant (+optional
   amount range) to a Category; applied automatically to future Transactions.
3. **Email resolution** — for **Unresolved charges** only: no Rule match AND (Plaid confidence
   below HIGH OR ambiguous payee — Amazon, PayPal, Venmo, Zelle, Cash App…). Runs
   **automatically after each sync**: Gmail search per charge, an LLM reads the matched
   Receipt and proposes a Category. Proposals land in the **review queue**; owner approves
   (minting a Rule) or rejects. **Never auto-applied** (matching is fuzzy). No ML classifier
   is built — Plaid covers generalization, Rules cover personalization (why not ML: see
   ADR-0005).

**Corrections = "learned patterns":** fixing a Category by hand mints or updates a Rule via
an "apply to future matches" toggle — default ON for normal merchants, OFF for ambiguous
ones (a one-off Amazon gift must not mint Amazon→Gift). Deterministic, auditable, no
training.

## Email resolution (Path B — automated, in-app)

- App owns **Gmail OAuth** to multiple Inboxes. Per-Inbox
  read-only refresh token in the **Keychain**.
- Scope `gmail.readonly` on an unverified personal app (test-user cap, consent-screen warning —
  expected, fine). Searches are narrow (amount + date window + Merchant); only the matched
  Receipt snippet reaches the LLM.

## Transfers & "saved" (see ADR-0003)

Money moving between the owner's own accounts is a **Transfer**, not income/expense. Detect by
pairing opposite-sign legs across Accounts (+ Plaid's signal); **exclude from spending, income,
cash-flow**; still show in the ledger. Credit-card payments are Transfers, not expenses.
Contributions into asset Accounts (savings, investment, 529) count as **saved**. Ambiguous
pairs → review queue. Every analytic below depends on this being right.

**Inside investment Accounts (brokerage, 529s), activity is invisible:** buys, sells, dividends,
and reinvestments never touch spending/income/cash-flow — they show up only in the balance
Snapshot (net worth, 529 projection). Only external contributions (saved) and withdrawals
matter; fund fees would surface via the fees Detector as a Concern, not an expense
(currently moot when the institution delivers balances only for these Accounts).

## Analytics

**Detectors (all 10 in v1)** — deterministic rules raising ranked Concerns; every threshold is
a tunable knob with a sane default, not a hardcoded constant:

spend spike · new recurring charge · subscription creep · fees & interest · negative cash flow ·
budget overage · duplicate charge · large one-off · low-balance runway · savings-rate drop

**Concern lifecycle:** each Concern has an identity (detector + subject + period, e.g.
`budget-overage:Dining:2026-07`); re-firing updates the existing Concern instead of
duplicating. Dismissible (stays gone unless severity materially worsens); auto-expires when
its period ends. Feed shows active Concerns ranked by severity.

**Budgets** — simple monthly caps: optional **Target** per chosen Category, actual-vs-target
fires the budget-overage Concern. No rollover, no zero-based. Untargeted Categories run
trend-only.

**Projections** (deterministic; the LLM may narrate but never produce the numbers; assumptions
always shown):
- **Net-savings run-rate** — trailing-avg (income − expenses) + known recurring, extrapolated.
- **529 college-goal funding** — per beneficiary: balance + contributions grown at an assumed
  return vs. a target cost at their college year. Inputs at setup: each beneficiary's age,
  target cost, return (default **5%/yr**, adjustable).
- **Counterfactual savings** — sum of flagged overages → "fix these, save ≈$Z/yr."
- (Deferred: balance/investment projection.)

## AI Insight layer

- Cloud **Claude** narrates locally-computed numbers only. **Digest sent = category totals,
  trends, top merchants — never account numbers, balances, or identity.** The digest also
  carries data-quality counts (open review items, Unresolved, rejected-not-reopened) so
  narration hedges figures the owner's hygiene backlog still moves.
- Triggers: on-demand "Explain this month" + one auto monthly summary, generated on the
  first launch of a new month. Not per-sync.
- Models are Settings knobs: Claude Haiku for receipt Proposals, Claude Sonnet for
  narration (defaults). No key / dead API → numbers render, narration says unavailable.

## UI surfaces (all 9 in v1)

| Surface | Graphs |
|---|---|
| **Dashboard** (landing) | net-worth line, this-month cash flow, top Concerns, savings run-rate |
| **Transactions** (ledger, inline Corrections) | — |
| **Review queue** (email Proposals + Receipt, ambiguous Transfers; J/K/A/R keyboard-driven) | — |
| **Concerns** (ranked, LLM-narrated) | severity list + sparklines |
| **Budgets** (Targets vs actuals) | progress bars |
| **Projections** | run-rate line, 529 funding-vs-target |
| **Accounts** (balances + Connection health / re-link) | balance history |
| **Rules** (view/edit learned Rules) | — |
| **Settings** (Categories + Plaid mapping, Detector knobs, 529 inputs, Inboxes, Connections) | — |

Core graph set: net worth over time · monthly cash flow · spending by category · category
trend · budget progress · the two projection charts.

Cross-cutting: **global search** (⌘K — merchant / amount / Category across all
Transactions) · **CSV export** of any filtered ledger view.

**Design system: Halo** (`~/Projects/resources/halo`) — dark-only, three charcoal surface
tiers, hairline borders, electric-indigo actions, JetBrains Mono numerics, Lucide icons,
stat-tile-with-sparkline as the signature pattern. Sidebar console layout across the 9
surfaces; `system.css` dropped in as the foundation; Observable Plot themed to the signal
tokens (lime = up/saved, magenta = down/overage, indigo = primary series).

## Stack (see ADR-0002)

TypeScript full-stack **SvelteKit** · **SQLite** (`better-sqlite3`) · charts via **Observable
Plot** · SDKs: `plaid`, `googleapis`, `@anthropic-ai/sdk`. No auth (localhost). Secrets in
**macOS Keychain**. Tauri wrapper deferred. Develop against **Plaid Sandbox** first; swap to
production keys once flows work.

## Privacy boundary (see ADR-0001)

Everything local except three deliberately-scoped egress channels: **Plaid** (ingestion),
**Claude** (digest-only narration), **Gmail read-only** (receipt lookup). LLM is never the
source of a number or a silently-applied Category.

## Owner setup

- **Plaid** — ✅ done: production keys in Keychain; institution link configured and verified.
- **529 setup data** — ✅ Settings inputs built (Phase 2): each beneficiary's age, target
  cost, assumed return.
- **Google Cloud** — outstanding, needed at p3-07: project + OAuth client,
  `gmail.readonly`, each Gmail as a test user (exact steps in the p3-07 issue).
- **Anthropic** — outstanding, needed at p3-07: API key via Settings → AI (Keychain).

## Explicitly out of scope / deferred

Native app wrapper · envelope/rollover budgeting · custom ML categorizer · local LLM ·
balance/investment projection · multi-user/auth · cloud hosting · truly-zero-egress manual
CSV · scheduled background sync (launchd) · phone/LAN access · light mode.

## Build plan — 3 phases, each ends usable

All three built (tracker: `.scratch/`). Phase 1 owner-accepted 2026-07-04 (p1-11);
Phase 2 built, owner acceptance open (p2-13); Phase 3 built, cloud go-live gate open
(p3-07 — the only step that needs the outstanding credentials).

**Phase 1 — Data pipeline** → real data, correctly categorized, browsable:
SvelteKit scaffold + Halo shell (sidebar, all 9 routes stubbed) · SQLite schema · Plaid link
+ sync (Sandbox → production) · balance Snapshots + backward reconstruction · Transfer
detection + pairing · Category taxonomy + Plaid mapping + Rules engine · surfaces: Accounts
(+ Connection health), Transactions ledger (inline Corrections + toggle), Rules, Settings
(Categories) · review queue (ambiguous Transfers only) · global search · CSV export.

**Phase 2 — Analytics** → the full local brain, zero cloud keys needed:
All 10 Detectors + Concerns feed (lifecycle, dismissal) · Budgets + Targets · the three
Projections · Dashboard with the full chart set (Plot themed to Halo) · Settings grows
Detector knobs + 529 inputs.

**Phase 3 — Cloud** → the two remaining egress channels:
Gmail OAuth + Inbox enrollment (Settings) · receipt search + LLM Proposals into the review
queue · keyboard-driven review (J/K/A/R) · AI Insight layer (monthly summary on first launch
of month + on-demand "Explain this month").
