# Monarch Features — Session Tracker

**The single source for the Monarch feature work.** This file consolidates the
deep-research audit of Monarch's help docs (the 20-feature list, the triage, and the
raw source articles — all deleted, recoverable via git history). An implementing agent
needs this file only.

20 features, batched into 5 sessions. Grouping principle: shared data model + shared
surface. Order: data → planning → analysis → shell → narration (dashboard deliberately
last — widgets are miniatures of pages that must exist first).

`✓` = verified against Monarch's own help docs · `○` = extracted from research, unverified.

To run a session: point a fresh session at this file. Mark the status log when done.

---

## Already done — no session needed

**#7 Transfer / credit-card-payment exclusion `✓`** — money moving between own accounts
(checking→savings, CC payments) is excluded from spending/income totals so it doesn't
double-count. Already built: `src/lib/server/transfers-db.ts`, excluded from
spending/income/cash-flow, contributions to asset accounts count as **saved**
(see CONTEXT.md "Transfer"). Verify it holds across every new rollup in Session 3.

---

## Session 1 — Taxonomy & learning `[ ]`

**Features:** #4 three-layer categories `✓` · #6 tags `✓` · #5 auto-categorization `✓` ·
#8 rules engine `○`

The schema everything downstream rolls up from — budgets, reports, and cash flow are
all category rollups. Must land first and alone.

### Decisions (grilled 2026-07-04 — these override the generic notes below)

- **#5 is real new work: a full LLM pass on all incoming transactions.** New ladder:
  `rule → correction → LLM → plaid map → Other`. One **batched** Haiku call per sync
  (existing `proposer_model` setting, key from Keychain) categorizes all new charges;
  result **auto-applies** with `category_source='llm'`, correctable like anything else.
  Plaid map demotes to offline/API-failure fallback (keep the settings editor).
  LLM prompt taxonomy excludes `Transfer` — transfer detection owns that.
- **Egress: maximum-relevant.** Send everything that plausibly helps categorize —
  merchant (raw + normalized), amount, date, Plaid category primary/detailed +
  confidence, account type, payment channel/description. Never account numbers,
  balances, or identity. **This supersedes ADR-0005 ("no ML") and widens ADR-0001
  channel 2 — write the ADR amendment as part of the session.**
- **Seed groups: Monarch's set.** Income (Income, Interest) · Auto & Transport
  (Transport) · Housing (Rent & Utilities, Home) · Bills & Utilities (Phone &
  Internet, Subscriptions) · Food & Dining (Coffee, Groceries, Dining) · Travel &
  Lifestyle (Travel, Entertainment, Personal Care) · Shopping (Shopping, Cash) ·
  Children (Kids, Pets) · Education (Education) · Gifts & Donations (Gifts, Charity)
  · Health & Wellness (Health) · Financial (Insurance, Fees, Taxes, Transfer) ·
  Other (Other).
- **Groups are containers only** — a Transaction always belongs to a category, never
  a group directly. Rollups group-by via join.
- **Disable = Monarch-style re-home:** disabling a category with history forces a
  bulk recategorize to a chosen replacement first (also re-point rules + plaid-map
  rows, like merge does), then hides it from pickers, LLM taxonomy, and budgets.
  `Income`, `Transfer`, `Other` get `Other`'s existing guard: no disable, merge, or
  delete.
- **Tags: full scope.** Schema (tags + txn↔tag join) · Settings > Tags CRUD · tag
  chip editor on transaction rows · quick `?tag=` filter on the transactions page
  (the cross-report filter engine still waits for Session 3) · **bulk tagging** via
  multi-select on the transactions list · **rules can attach tags** (rule_tags join;
  a merchant rule may set category and/or add tags).
- Trivia settled: nullable emoji column on categories and groups; `sort_order` on
  both; custom group CRUD (deleting a group requires moving its categories first).

### #4 Three-layer category system
Categories nest: **groups** contain **categories**; every Transaction gets exactly one
category. In Monarch (Settings > Categories) the user can:
- Rename categories and groups; personalize the **emoji icon**
- **Disable** unused ones (e.g. mortgage if you rent) — if transactions are already
  assigned to a disabled category, prompt to move them to another
- Create **custom** categories and groups
- **Reorder** categories/groups and **move** categories between groups

*Why:* a flexible taxonomy means the whole analytical layer reflects how the owner
thinks about money, not a fixed chart of accounts.

### #6 Tags
A second, **orthogonal** label: one category per transaction, but **many tags**. Tags
cut across categories — "Vacation 2026", "Tax deductible", "Reimbursable" — grouping
spend the category tree can't ("everything for the wedding" across dining, travel,
shopping). Managed in Settings > Tags.

*Why:* categories answer "what kind?"; tags answer "which project/event/purpose?".

### #5 Auto-categorization
Incoming transactions arrive with a category assigned automatically, so the owner
reviews and corrects instead of labeling from scratch. Monarch treats this as integral
(can't be turned off). *Why:* manual categorization is the #1 reason people abandon
budget apps; ~80% right on arrival is the highest-leverage retention feature.

**Existing:** the categorization ladder in `src/lib/server/categorizer.ts`
(Plaid category mapping + Rules + Corrections). Work = upgrade it to read/write the
new group/category tree, not greenfield.

### #8 Rules engine
When the owner recategorizes a transaction, offer to create a **rule** ("Create rule"
prompt on edit) so future similar transactions are handled automatically. Rules encode
corrections into standing automation; ML/heuristics handle the general case, rules
handle "this merchant always goes here."

**Existing:** Rules + Corrections already built (`src/routes/rules`, corrections flow,
"apply to future matches" toggle — see CONTEXT.md "Rule"/"Correction"). Work = make
rules target the new tree; keep merchant+amount-range matching.

**Touches:** DB schema (groups, tags, tag↔txn join), `categorizer.ts`,
rules/corrections, Settings UI, transactions UI (tag chips, grouped category picker).

---

## Session 2 — Budgets v2 `[ ]`

**Features:** #9 Flex vs. Category budgeting `✓` · #10 "left to budget" `✓` ·
#11 rollovers `○`

One page, one engine — three features that are one budget-math rewrite of
`src/lib/server/budgets.ts` + `src/routes/budgets`.

### #9 Flex vs. Category budgeting
Two styles, switchable **anytime** in Budget > Settings:
- **Flex** (Monarch's default): discretionary spending collapsed into one flexible
  number — less precise, less maintenance
- **Category**: traditional line-by-line budget per category

*Why:* budgeting rigor is a personality spectrum; a one-click switch serves both the
casual majority and the detail-oriented without fragmenting the app.

### #10 "Left to budget" stat
Budget mechanics: **expected monthly income sets the budget total**; expenses and
savings are subtracted to balance the month. A running "left to budget" figure shows
unallocated (or over-allocated) income. Prerequisite: income transactions correctly
categorized (paychecks, interest, bonuses). *Why:* the zero-based heartbeat — one
number says whether the plan is balanced, over-committed, or has slack. The page's
north-star metric.

### #11 Rollover budgets
Budgets reset monthly by default. Rollover is a **per-category toggle** (gear icon):
surplus or shortfall carries into next month — under-spend groceries in January,
February starts with the extra. *Why:* monthly resets punish lumpy-but-real spending;
rollovers enable sinking funds (car maintenance, gifts).

### Decisions (grilled 2026-07-04)

- **Per-month budget rows** replace the static `targets` table: keyed
  `(category_id, month)`, lazily filled forward — a month inherits the previous
  month's amount until edited, then diverges. Past months are frozen facts, so
  rollover balances and history never mutate retroactively. Existing `targets`
  seed the current month on migration; `targets` is dropped.
- **Expected income = budgeted income categories.** The same per-month rows apply
  to Income-group categories; their sum is the month's expected income. The
  budgets page gains an Income section above Expenses.
- **Left to budget = expected income − expense allocations.** Savings is
  **implicit** — positive slack *is* the savings plan; no explicit savings line,
  no goals dependency.
- **Flex classification is two-way**: every expense category is `fixed` or
  `flexible` (new column, seeded by group — Housing/Bills/Insurance-type fixed,
  rest flexible; editable in Budget settings). Flex mode = fixed categories
  line-by-line + **one pooled flex budget** (its own per-month number). Monarch's
  non-monthly bucket is covered by fixed + rollover instead of a third state.
- **Mode switch is non-destructive**: Category-mode lines and the Flex pool both
  persist; the toggle only changes which view drives the math.
- **Rollover: both directions, anchored at enable.** Balance starts $0 the month
  the per-category toggle flips on; each month adds budget − actual, surplus and
  shortfall alike. Toggle off/on re-anchors to $0 (the reset affordance — no
  balance-editing UI). The Flex pool does **not** roll over.
- **Categories only are budgetable** — Groups show rolled-up subtotals but have
  no lines of their own (Flex mode is the coarse-grained style).
- **Category mode shows all expense categories grouped by Group**, unbudgeted
  ones with blank budget + actual spend, so no spending leaks invisibly out of
  the left-to-budget slack. Adding a line = filling the blank.
- Per-month rows imply **month navigation** (prev/next) on the budgets page;
  future months are editable via the same fill-forward.

**Depends on:** Session 1 (budgets roll up by the new tree/groups).

---

## Session 3 — Analysis engine: Reports + Cash Flow `[ ]`

**Features:** #15 three report tabs `✓` · #16 per-tab chart types `✓` ·
#17 deep filtering `✓` · #18 saved reports `○` · #12 Sankey/bar cash flow `○` ·
#13 breakdown & filters `○` · #14 savings-rate % `○`

Seven features, one core: a **shared filter engine** — #13 and #17 are the same
feature on two pages. Build it exactly once. Chart primitives mostly exist in
`src/lib/charts/` (Sparkline, ProgressBar, LineChart, BarsChart).

### The filter engine (#13 + #17)
Filter by **category, group, account, tag, merchant, date range** — the same
vocabulary on every report and on cash flow. Drill into a slice ("just dining, last
3 months"). *Why:* a static report answers one question; a filterable one answers
hundreds, with controls learned once and reused everywhere.

### Reports (#15, #16, #18)
- **Three tabs:** spending / income / net worth & trends — three questions ("where
  does it go?", "where from?", "am I building wealth?"), three focused views instead
  of one mega-report.
- **Per-tab chart types:** the chart that fits the question — trend lines for net
  worth, category breakdowns for spending. Chart type is an argument about the data.
- **Saved reports:** a filtered configuration can be saved and re-opened ("dining,
  this year, excluding travel") — a bookmark, not a task to rebuild.

### Cash Flow (#12, #14)
- **Sankey or bar chart:** income sources → categories → spending and savings, flows
  as ribbons. The "where did it all go?" view; big ribbons are big money.
- **Savings-rate %:** share of income kept rather than spent, over a period. The best
  one-number summary of financial health — reframes the goal from "spend less" to
  "keep more."
- Verify #7 transfer exclusion holds in every rollup here.

### Decisions (grilled 2026-07-04)

- **Filters: include + exclude, multi-value, on every dimension** (category,
  group, account, tag, merchant) plus date range. Date ranges are presets
  (this month, last 3 months, YTD, last 12 months, all time) + custom from/to.
  Filter state lives in the URL query string — shareable, back-button-friendly,
  and a saved report is a named config.
- **Breakdown charts: BOTH donut and ranked horizontal bars** — donut for the
  top slices + "other", ranked labeled bars below. Two new chart primitives.
- **Group-by: Group / Category / Merchant / Tag** on every breakdown.
- **Sankey: build it, two levels + savings ribbon** — income Categories →
  spine → expense Groups, with an explicit Savings ribbon for the residual.
  Drill-down happens via the filter engine (click a ribbon = apply filter),
  not in-diagram expansion. Cash Flow page also gets monthly
  income-vs-expenses bars for trend across periods.
- **Savings rate on analysis pages = leftover-based**: (income − expenses) /
  income, agreeing with the Sankey ribbon and Monarch. The existing
  `is_saved`-based metric survives elsewhere relabeled ("moved to savings").
- **Saved reports capture the full page config** (page, tab, group-by, chart
  view, filter set) for **both Reports and Cash Flow**. Date presets are saved
  relative ("this year" re-opens as the current year); custom ranges are saved
  absolute.
- **Hard two-pass seam** (Session 1 playbook): **Pass A** = filter engine +
  Reports (three tabs, donut + ranked bars, saved reports) + **transactions-page
  retrofit** onto the engine (owner's call — the page becomes the engine's
  second consumer, proving it's genuinely shared); **Pass B** = Cash Flow
  (Sankey, monthly bars, savings rate, saved-report page field) only after
  Pass A's tests are green.
- Monthly time grain only; new routes for Reports and Cash Flow (Session 4
  arranges the nav).

**Depends on:** Session 1 (filters need tags + groups). Split seam is now the
decided structure: **3a** filter engine + Reports + retrofit, **3b** Cash Flow.

---

## Session 4 — Shell: Nav + Dashboard `[ ]`

**Features:** #1 top-level navigation `✓` · #2 customizable widget grid `✓` ·
#3 widget library `✓`

After 1–3 on purpose: every widget is a miniature of a section, so the library is
mostly extracting compact views from finished pages.

### #1 Top-level navigation (9 sections)
Monarch's fixed spine, each section one focus:
**Dashboard** (surfaces what matters) · **Accounts** (where money lives) ·
**Transactions** (day-to-day; categories and tags organize it) · **Reports** and
**Cash Flow** (trends over time) · **Budgets** and **Recurring** (monthly planning) ·
**Goals** (the future) · **Investments** (portfolio) · **Settings** (account,
preferences, institutions, categories, rules, tags).

*Why:* the mental model **is** the product — the user always knows which tab answers
which question. Map existing routes (`/concerns`, `/projections`, `/review`, `/rules`,
`/inboxes`, `/sync`) into these sections. Recurring and Goals aren't in the 20
(Goals 3.0 was triaged **skip**; Recurring is a research blind spot) — stub or omit,
owner's call at session time.

### #2 Customizable widget grid
Dashboard = grid of widgets, each summarizing info from elsewhere. A **Customize**
button (top-right on web) enters a mode where widgets can be **removed/hidden and
drag-and-drop reordered**; layout persists. *Why:* the home screen opens to the
owner's priority, not a fixed one — high perceived personalization, low cost.

### #3 Widget library
Monarch's widget set: Getting-started guide, Credit score, Budget, Net worth,
Recurring transactions, Spending trend, Transactions, Investments, Advice.
Ours maps to: **Budget, Net worth, Spending trend, Recent transactions, Investments,
Weekly Recap** (slot for Session 5) — skip credit score/advice/getting-started.
*Why:* each widget is a compressed view of a full section — forces the question
"what one number or trend matters without drilling in?"

**Depends on:** Sessions 1–3 (needs the pages to miniaturize).

### Decisions (grilled 2026-07-04)

- **Spine (8 sections):** Dashboard · Accounts · Transactions · Reports ·
  Cash Flow · Budgets · Recurring · Settings. **Recurring ships as a stub**
  (existing `Placeholder.svelte`); Goals and Investments are omitted from the
  nav entirely — no dead tabs for triaged-skip features.
- **Fold-ins (routes unchanged, sidebar shrinks):** Review queue → entry link
  with open-count badge on the Transactions page; Projections → sibling tab on
  Cash Flow (past = Sankey, future = projections); Concerns → reached from its
  Dashboard widget ("view all"); Rules → linked from Settings. Command palette
  keeps every page reachable.
- **Widget library (8):** Month summary tiles · Budget (left-to-budget + top
  category bars) · Net worth · Spending trend · Recent transactions · Concerns ·
  Run-rate projection · Monthly insight narration. **No Investments widget**
  (owner call — balances already live in Accounts; portfolio was triaged skip).
  Weekly Recap is *not* a placeholder: Session 5 registers it; S4 just makes
  registration cheap.
- **Grid mechanics:** widgets declare half/full width in a 2-col grid; hide +
  reorder only, no user resizing. Customize mode auto-saves every change
  (single-user local app). Layout persists as one settings JSON key (ordered
  ids + hidden flags). Load computes data only for visible widgets.
- **Drag-and-drop: svelte-dnd-action** (owner call, one new dependency) —
  smooth, keyboard-accessible, touch-capable reordering over hand-rolled
  HTML5 DnD.
- **Honesty banners stay fixed chrome** above the grid (warming-up detectors,
  unreviewed transfer candidates) — warnings that qualify the numbers must not
  be hideable.
- **Build seam:** two passes, hard seam — **4a** nav shell (spine, fold-ins,
  stub, Cash Flow|Projections tabs), **4b** widget registry + grid + customize
  mode. B starts only when A's tests are green.

---

## Session 5 — AI `[ ]`

**Features:** #19 AI Assistant `✓` · #20 AI Insights + Weekly Recap `○`

Mostly the conversational surface — proactive machinery largely exists
(`insights.ts`, `concerns.ts`, `projections.ts`, detectors, monthly auto-summary).

### #19 AI Assistant
Conversational: ask about your finances ("what patterns should I be aware of?"), how
features work, what to do next. **Privacy contract** (from Monarch's own docs, and a
fit for this app's local-first stance):
- **Minimal data:** send only what the question needs — transaction descriptions,
  dates, amounts; **never** credentials, email, or full account numbers
- Call shape: "Here is a set of data points representing this month's spending —
  what patterns or insights should they be aware of?" → text analysis back →
  nothing retained by the model
- **Optional & opt-out-able** (Settings > Preferences); app fully functional without
- Per-message **thumbs up/down** feedback
- Optional household context (dependents, income, filing status) for more
  personalized guidance — owner-controlled

*Why:* collapses the gap between having data and understanding it. Especially strong
here: owner's own model keys, owner controls exactly what's sent, no vendor retention.

### #20 AI Insights + Weekly Recap
Two proactive features (Assistant is pull; these are push):
- **Insights:** surface notable patterns automatically ("dining up 40% this month")
  without being asked — extend the existing detectors
- **Weekly Recap:** a dashboard widget summarizing the financial week in a short
  digestible format; removable via dashboard Customize. Weekly variant of the
  existing monthly auto-summary, landing in the Session 4 widget slot.

*Why:* most users won't think to ask the right question; the Recap is a standing
reason to open the app weekly.

**Depends on:** Sessions 1–4 (real data to reason over + widget slot).

### Decisions (grilled 2026-07-04)

- **Assistant surface: slide-over panel**, opened from a persistent sidebar
  button + keyboard shortcut, over any page — the S4 spine stays 8 sections.
  Hidden entirely when no API key is set (`anthropicReady` is the opt-in gate;
  no separate toggle — no key, no AI).
- **Context strategy: small audited tool set** over the S3 engines — run a
  report (FilterSet → aggregates), list matching transactions (descriptions/
  dates/amounts only, capped count), budget month, digest. Read-only tool loop
  with a hard iteration cap; every tool result logged locally for egress audit.
  Payloads honor the privacy contract: never credentials, email, account
  numbers, or balances. Requires extending the text-only `Llm` seam with a
  tool-loop variant (same Keychain key, same fake/real split).
- **History: multiple conversations** (owner call) — Monarch-style thread
  list with new/delete, persisted in SQLite (new migration: conversations +
  messages).
- **Extras: both ship** (owner call) — household context (dependents, income,
  filing status; owner-written settings, appended to system prompt only when
  set) and per-message thumbs up/down (feedback column on messages;
  write-only data today, honest about that).
- **#20 Insights half: already built — no new machinery.** The detector →
  concerns → dashboard pipeline is the feature (spendSpike fires "dining up
  40%" today). S5 marks it built rather than rebuilding it under a new name.
- **Weekly Recap:** ISO Monday weeks; recap covers the just-completed week;
  generated by the existing sync-hook pattern (first sync on/after a new
  week, mirroring monthly insights — no daemon); stored as a new insight kind
  keyed by week period; weekly digest mirrors the monthly Digest scoped to
  the week (figures, week-over-week deltas, top categories/merchants, large
  one-offs, data-quality hedging counts). Registers as the ninth widget via
  S4's registration contract — removable via Customize for free.
- **Build seam:** two passes, hard seam — **5a** weekly digest + Recap +
  widget registration (all patterns exist), **5b** Assistant (conversations
  migration, tool set, panel, extras). B starts only when A's tests are
  green; the halves share only the pre-existing LLM seam.

---

## Triage context (from the deep-research audit)

**Tally:** 20 want (above) · 10 skip · 0 have at triage time (#7 since confirmed built).

**Skipped — do not build:** independent web/mobile dashboard layouts · swipeable
monthly review (mobile) · multi-type account aggregation · 11,000+ institutions ·
net-worth-over-time page · split transactions · web 3-col/mobile 2-col budget layout ·
multi-asset holdings · portfolio analysis · Goals 3.0 (save-up/pay-down goals with
fund allocations).

**Research blind spots (never triaged, no data):** Goals mechanics · Recurring/bills ·
collaboration/household · notifications/alerts · advisor tools.

**Source notes:** 11 of 20 verified (`✓`) against Monarch help docs ("Getting Started
with Monarch", "Customizing Your Dashboard", "AI in Monarch"); 9 extracted (`○`) —
worth a sanity check against the live product before deep investment. Raw article
dumps were deleted from the repo after consolidation into this file (git history has
them: `monarch-body.txt`, `monarch-budget.txt`, `monarch-ai-body.txt`,
`monarch_ai_article.md`, `goals3_body.txt`).

---

## Status log

| Session | Status | Date | Notes |
|---|---|---|---|
| 1 — Taxonomy & learning | not started | | |
| 2 — Budgets v2 | not started | | |
| 3 — Reports + Cash Flow | not started | | |
| 4 — Nav + Dashboard | not started | | |
| 5 — AI | not started | | |
