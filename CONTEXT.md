# Money Tracker

A local-first personal finance tracker for a household's bank accounts
(including investment and 529 education accounts).
It pulls data via Plaid, categorizes transactions, and surfaces analytics and
AI-narrated insights. All data stays on the owner's device; only Plaid ingestion and
deliberately-scoped AI/email lookups ever leave it.

## Language

**Account**:
One of the owner's financial accounts — credit card, debit, checking, savings,
investment, or education fund. Belongs to one Connection.
_Avoid_: wallet

**Connection**:
A single Plaid login to one institution, covering all of that institution's Accounts.
One login can carry depository, investment, and 529 Accounts together — no separate
Connection per account type.
_Avoid_: Item (Plaid's internal word), integration

**Transaction**:
A single posted money movement on an Account — has a date, amount, Merchant, and Category.
_Avoid_: purchase, payment, entry

**Transfer**:
A movement of money between two of the owner's own Accounts — checking→savings, a credit-card
payment, or a savings/investment/529 contribution. Detected by pairing opposite-sign legs
across Accounts (plus Plaid's signal) and **excluded from spending, income, and cash-flow**,
though still shown in the ledger. A contribution into an asset Account (savings, investment,
529) counts as **saved**, not spent. Ambiguous pairs go to the review queue.
_Avoid_: payment, internal payment, movement

**Merchant**:
The normalized payee of a Transaction, stripped of processor noise (`SQ*`, `TST*`, store
numbers). This normalized form is the matching key for Rules.
_Avoid_: payee, vendor

**Category**:
The classification of a Transaction (e.g. Coffee, Groceries). Base value comes from Plaid;
may be overridden by a Rule or a Correction. The owner's word "labeling" means assigning a
Category. Deleting a Category always means re-homing: its Transactions move to a
category the owner picks, then it is removed — deleting *is* re-homing, one gesture.
"Disable" is no longer a user-facing verb (grill session 2026-07-06, second session).
Other, Income, and Transfer are load-bearing and cannot be deleted.
_Avoid_: Label, tag, class, disable/archive

**Rule**:
A stored override mapping a Merchant (optionally plus an amount range) to a Category,
applied automatically to future Transactions. Minted or updated by a Correction.
Which Rule categorized a Transaction is never recorded — "the rules that apply" always
means Rules matching *now*, which can differ from the Rule that fired historically
(grill session 2026-07-06).
_Avoid_: pattern, mapping

**Correction**:
The owner changing a Transaction's Category by hand. A Correction mints or updates a Rule
via an "apply to future matches" toggle — default ON for normal Merchants, default OFF for
ambiguous ones (Amazon, Venmo…), where one charge says nothing about the next ("learned
patterns", with a one-off escape hatch). A **bulk** Correction (many selected
Transactions at once) never mints a Rule — it is always a one-off batch fix; to teach a
pattern, correct one Transaction singly (grill session 2026-07-06).
_Avoid_: edit, fix, relabel

**Unresolved charge**:
A Transaction with no matching Rule AND (Plaid category confidence below HIGH, OR an
ambiguous-payee Merchant: Amazon, PayPal, Venmo, Zelle, Cash App…) — the candidate set for
email-lookup resolution.
_Avoid_: unknown transaction, mystery charge

**Inbox**:
One Gmail account the app is authorized to search for Receipts. The owner enrolls several;
the app holds a per-Inbox read-only token in the macOS Keychain.
_Avoid_: email account, mailbox

**Receipt**:
The email message matched to a charge (order confirmation, payment note), distilled into
Receipt facts that inform the categorizer. Matching is fuzzy (amount + date window +
Merchant), so a Receipt is evidence, never proof.
_Avoid_: confirmation, invoice

**Receipt facts**:
Structured knowledge extracted from a matched Receipt onto its Transaction (ADR-0007): a
one-line description of what the purchase was for, line items when the email shows them,
and the vendor's own name. Visible on the ledger and Transaction detail; the categorizer
consumes them and auto-applies with the distinct `llm+receipt` source. Rules and
Corrections still outrank any model assignment.
_Avoid_: Proposal (retired 2026-07-05 — the review queue is Transfer pairing only)

**Recurring series**:
A detected run of ≥3 same-Merchant charges at a stable cadence (weekly, monthly, or annual)
and stable amount — the unit of the Recurring page, and what Detectors and Projections
consume. Its state is always derived from today vs its last occurrence: **upcoming**
(next charge expected), **late** (past expected date, under ~2 missed cycles — still a
commitment), or **ended** (~2+ missed cycles — treated as cancelled, out of the committed
total). The latest amount drifting from the typical amount is the price-creep signal, not
an error (grill session 2026-07-06). Recurring-ness is an attribute a Transaction has
*in addition to* its Category, never instead of one — rent is Housing *and* recurring.
There is no "Recurring" Category, and "subscription" names nothing the app
distinguishes (grill session 2026-07-06, second session). When a view asks "which
Category does this series belong to," the answer is the Category where its Merchant's
charges dominantly land (the most common one) — a series has no Category of its own
(implementation session 2026-07-06).
_Avoid_: subscription (a kind of series, not the concept), bill, Recurring as a Category

**Muted merchant**:
A Merchant the owner has marked "not a bill" — detection skips it entirely, so no Recurring
series, Concerns, or Projection input exist for it. Keyed on Merchant, so it outlives
detection rebuilds. Reversible from the Recurring page.
_Avoid_: ignored, blacklisted

**Detector**:
A deterministic rule that scans Transactions for one pattern worth attention (spend spike,
new recurring charge, fee, budget overage, etc.). Runs locally; raises Concerns.
_Avoid_: rule (reserved for categorization), check, alert

**Concern**:
One instance of a Detector firing — the unit shown in "areas of concern." Has a computed
severity so the feed can be ranked. An Insight may narrate the top Concerns.
_Avoid_: alert, warning, flag, issue

**Budget**:
A per-month planned amount for a Category (replaces *Target*, 2026-07-04). Stored per
`(Category, month)`; a month inherits the last set amount until edited (fill-forward), so
past months are frozen facts. Actual-over-Budget raises a budget-overage Concern.
_Avoid_: Target (retired), limit, envelope

**Budget mode** (retired 2026-07-06):
Was: Category mode vs Flex mode on the budgets page. Retired with the merge into the
Categories page — budgeting is per-Category only ("hard budgets"). Stored Flex
configuration is kept in the DB but drives nothing.
_Avoid_: mode, view

**Flex pool** (retired 2026-07-06):
Was: the single pooled budget covering all flexible Categories in Flex mode. Retired with
Budget mode.
_Avoid_: discretionary bucket, everything-else

**Rollover balance**:
The cumulative budget-minus-actual since a Category's anchor month; carries surplus and
shortfall alike. Anchored at $0 when toggled on; toggle off/on re-anchors (the only reset).
_Avoid_: carryover, sinking fund (that's what it builds, not what it is)

**Left to budget**:
Expected income (budgeted Income-group Categories) minus the month's expense allocations.
Zero is balanced; positive slack is the implicit savings plan; negative is over-committed.
_Avoid_: remaining, unallocated, savings line

**Month cursor**:
The single selected month on the Categories page, stepped back/forward with arrows and
defaulting to the current month. It is a property of the page, not of the view within it:
opening a Category, stepping months inside it, and closing it never resets the cursor —
you land back on the category list *in the month you were viewing*. Auditing works by
holding a Category open and stepping the cursor through history (grill session
2026-07-06, second session).
_Avoid_: date filter, period picker

**Insight**:
An LLM-generated plain-English narrative over numbers computed locally (e.g. "dining is up
40% this month"). An Insight narrates figures; it never invents them.
_Avoid_: analysis, report, summary

**Projection**:
A deterministic forecast computed by arithmetic over historical Transactions (e.g. projected
savings). An Insight may narrate a Projection but must not produce one.
_Avoid_: forecast, estimate, prediction

**Snapshot**:
A per-Account balance recorded at every sync. Snapshots are the truth for net worth going
forward; history before day 1 is reconstructed backwards through Transactions (cash Accounts
only) and marked estimated. Investment Accounts have no reconstructed history.
_Avoid_: balance history, backfill

**Ledger**:
The one surface that lists Transactions, wherever it appears — under a Category, inside
a Report, or as the Transactions page itself. Identical everywhere: same rows, same
detail-on-click, same multi-select, same Correction affordances. A Ledger opened from a
host view always closes back to exactly that host view, and a Transaction opened from a
Ledger closes back to that same filtered Ledger (grill session 2026-07-06, second
session). There is never a second, lesser way to list Transactions.
_Avoid_: transaction list, table, read-only preview

**Filter set**:
The six-dimension question every analysis view answers: per dimension (Category, Group,
Account, Tag, Merchant) an optional include ("only these") and exclude ("all except") list,
plus a date range (relative preset or absolute from/to). Lives in the URL query string, so
every filtered view is bookmarkable and back-button-friendly by nature.
_Avoid_: search, query params

**Saved report**:
A named filter set plus page configuration (page, tab, group-by) — a bookmark, not a task
to rebuild. Date presets stay relative ("this year" re-opens as the current year); custom
ranges stay absolute.
_Avoid_: template, favorite

**Breakdown**:
A filtered total decomposed by Group, Category, Merchant, or Tag — rendered as a donut of
the top slices plus "other" over ranked labeled bars.
_Avoid_: pie, distribution

**Savings rate**:
(income − expenses) / income for a period — the leftover share, agreeing with the Cash Flow
Savings ribbon by construction; null when the period has no income. Distinct from **moved
to savings**, the explicitly-saved metric (is_saved contribution legs / income) — two
honest numbers, two names.
_Avoid_: using it interchangeably with moved-to-savings

**Split Charge**:
A manually-entered subscription payment on the Splits surface (provider, date, amount).
Consecutive same-provider Split Charges bound a **Split Period**: charge date → next
charge date, end-exclusive; the latest period stays open/live.
_Avoid_: subscription, bill (those are Recurring's words)

**Split Period**:
One Split Charge's cost window, attributed by usage: matched-project share of provider
usage cost (the ccusage CLI behind a seam) × the charge amount. Closed periods freeze
their result in the DB; the open period recomputes at most hourly. The partner owes a
settings-defined share of the frozen attributable total, minus **Repayments** — a manual
ledger optionally linked one-to-one to incoming Transactions. All identity (partner name,
section label, project patterns) lives in settings, never code.
_Avoid_: billing cycle, invoice

## Flagged ambiguities

- **Label vs Category** — the owner said "labeling." Resolved as: "labeling" = assigning a
  **Category**. _Resolved 2026 (stories 17–19):_ free-form **Tags** now exist alongside
  Categories — many-per-Transaction, attachable via Rules or the Ledger, filterable (see
  the Filter set entry). "Labeling" still means Category assignment.
- **Unresolved charge** — name kept; definition made concrete (grill session 2026-07-04):
  no Rule + (confidence < HIGH OR ambiguous payee).

## Example dialogue

> **Dev:** This Starbucks charge came in as "Coffee" from Plaid — leave it?
> **Owner:** Yes, but the one labeled "Shopping" is actually a gift card. Fix it.
> **Dev:** So I'll make a Correction on that Transaction. That mints a Rule — Merchant
> "Starbucks" plus that amount range maps to "Gift". Future matches auto-apply.
> **Owner:** And the AMAZON one? I have no idea what that was.
> **Dev:** That's an Unresolved charge — Plaid and your Rules can't split Amazon. The email
> lookup searches your inbox for the receipt, puts what it bought on the row as Receipt
> facts, and the categorizer re-judges with that evidence — you'll see the source read
> `llm+receipt`. If it's wrong, correct it and that Correction becomes a Rule too.
