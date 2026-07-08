# Money Tracker

Local-first personal finance app: bank, investment, and 529 accounts via Plaid,
a deterministic categorization ladder with an LLM rung, Gmail receipt matching,
and AI-narrated insights — all data on your own machine.

![Dashboard: monthly cash flow, savings rate, budget, and net-worth chart](docs/images/dashboard.png)

*All screenshots show Plaid sandbox data (First Platypus Bank) — no real financial information.*

## Highlights

- **Local-first, zero-egress by design.** All financial data lives in a local
  SQLite file; there is no cloud server, no auth, no telemetry. Exactly three
  deliberately-scoped egress channels exist — Plaid ingestion, an anonymized
  digest to Claude for narration, and read-only Gmail receipt search — each
  documented in [ADR-0001](docs/adr/0001-local-only-data-with-scoped-egress.md).
- **Deterministic money path.** Categorization is a ladder — Rule → Correction →
  LLM → Plaid map → Other — where anything the owner taught the system is never
  second-guessed and history is never re-labeled by a model
  ([ADR-0006](docs/adr/0006-llm-categorization-rung.md)).
- **Enrich then categorize.** Matched Gmail Receipts are distilled into
  structured Receipt facts on the Transaction row; one unified categorizer
  consumes bank evidence plus Receipt facts
  ([ADR-0007](docs/adr/0007-enrich-then-categorize.md)).
- **Transfer detection that keeps analytics honest.** Movements between the
  owner's own Accounts are paired and excluded from spending/income;
  contributions to savings/investment/529 count as saved
  ([ADR-0003](docs/adr/0003-internal-transfers-excluded-contributions-are-saved.md)).
- **Every LLM call goes through one seam** (`Llm`), so the entire receipt and
  insight pipeline is tested against fakes — the test suite never touches the
  network.
- **Decisions are written down.** Eight [ADRs](docs/architecture.md#adr-index)
  record the real trade-offs: build-vs-buy on aggregators, rules-vs-ML
  categorization, why budgets merged into the Categories page.
- **TypeScript full-stack** — SvelteKit + better-sqlite3 + Observable Plot;
  secrets live in the macOS Keychain, never in the DB or repo.

See [docs/architecture.md](docs/architecture.md) for the system shape and ADR index.

| | |
|---|---|
| ![Transactions ledger with category sources, recurring badges, and filters](docs/images/transactions.png) | ![Categories page: monthly Sankey of where the money went, with budgets per category](docs/images/categories.png) |
| ![Review queue for ambiguous Transfer candidates, keyboard-driven](docs/images/review.png) | ![Accounts surface: per-account balance history, including reconstructed estimates](docs/images/accounts.png) |

## Try it in ~5 minutes (sandbox, no real bank)

Plaid's sandbox provides fake institutions and data — no real bank account or
production keys needed.

1. Create a free [Plaid dashboard](https://dashboard.plaid.com) account (Trial
   plan, Transactions + Investments products), then seed the sandbox keys into
   the macOS Keychain:

   ```sh
   security add-generic-password -s money-tracker -a plaid-client-id -w <client_id>
   security add-generic-password -s money-tracker -a plaid-secret-sandbox -w <sandbox_secret>
   ```

2. Install and start:

   ```sh
   npm install
   npm run dev        # → http://localhost:5273 (fixed port)
   ```

3. Open the Accounts surface, click **Add Connection**, and log in with Plaid's
   sandbox credentials `user_good` / `pass_good`. Sync pulls fake transactions
   through the full pipeline: ledger, categorization ladder, transfer pairing,
   analytics.

**What works without any cloud keys:** everything deterministic — sync,
ledger, categorization (Plaid-map floor), transfers, review queue, budgets,
charts, projections, search, CSV export. **What degrades gracefully:** the LLM
categorization rung, Receipt matching, and AI narration slots show
"unavailable" until an Anthropic key / Gmail enrollment is added — ingestion
never blocks on a third party. In sandbox mode the Connection health mark
shows "degraded"; that's cosmetic and expected.

## Run

```sh
npm run dev        # → http://localhost:5273 (fixed port)
npm test           # vitest — money-path modules
npm run check      # svelte-check
```

Data lives in `~/Library/Application Support/Money Tracker/money.db` (SQLite, WAL).
Migrations in `src/lib/server/db/migrations/` apply on boot. Nothing financial or
secret ever lands in this repo.

Contributors: read `PLAN.md`, `CONTEXT.md`, and `docs/adr/` before changing anything.

## Production setup (once)

Real bank data: add `plaid-secret-production` to the Keychain the same way as
the sandbox secret and start the app with `PLAID_ENV=production npm run dev`.

## Cloud setup (once — email receipts + AI insights)

Optional; without keys everything still runs and narration slots say unavailable.

- **Gmail**: Google Cloud project + OAuth client (Web application), redirect URI
  `http://localhost:5273/inboxes/oauth/callback`, Gmail API + `gmail.readonly`,
  each Gmail as a test user. Seed `google-client-id` / `google-client-secret` in
  the Keychain (commands shown in Settings → Inboxes), then enroll each Inbox there.
- **Anthropic**: API key via Settings → AI (stored in the Keychain).

Go-live checklist: `.scratch/p3-07-cloud-golive-acceptance/ISSUE.md`.

## Where things are

- `docs/architecture.md` — system shape, module map, ADR index
- `src/lib/server/` — db, plaid adapter, sync engine, categorizer, transfers,
  balances, corrections, ledger/search/CSV, gmail + matcher + resolution
  (receipt pipeline), digest + insights (pure money-path modules have
  tests alongside as `*.test.ts`; gmail/LLM tested against fakes)
- `src/lib/server/llm.ts` — the `Llm` seam every Anthropic call goes through
- `src/routes/` — the surfaces; `src/lib/halo.css` — Halo design system
- `.scratch/` — historical issue archive (tracker now lives on GitHub Issues,
  see `docs/agents/issue-tracker.md`)
