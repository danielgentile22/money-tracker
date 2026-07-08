# Money Tracker

Local-first personal finance app: bank, investment, and 529 accounts via Plaid.
Read `PLAN.md`, `CONTEXT.md`, and `docs/adr/`
before changing anything.

## Run

```sh
npm install
npm run dev        # → http://localhost:5273 (fixed port)
npm test           # vitest — money-path modules
npm run check      # svelte-check
```

Data lives in `~/Library/Application Support/Money Tracker/money.db` (SQLite, WAL).
Migrations in `src/lib/server/db/migrations/` apply on boot. Nothing financial or
secret ever lands in this repo.

## Plaid setup (once)

Create a Plaid dashboard account (Trial plan, Transactions + Investments), then:

```sh
security add-generic-password -s money-tracker -a plaid-client-id -w <client_id>
security add-generic-password -s money-tracker -a plaid-secret-sandbox -w <sandbox_secret>
```

Reload the Accounts surface and click **Add Connection** (Sandbox login:
`user_good` / `pass_good`). Production cutover (p1-11): add
`plaid-secret-production` the same way and start the app with `PLAID_ENV=production`.

## Cloud setup (once — email receipts + AI insights)

Optional; without keys everything still runs and narration slots say unavailable.

- **Gmail**: Google Cloud project + OAuth client (Web application), redirect URI
  `http://localhost:5273/inboxes/oauth/callback`, Gmail API + `gmail.readonly`,
  each Gmail as a test user. Seed `google-client-id` / `google-client-secret` in
  the Keychain (commands shown in Settings → Inboxes), then enroll each Inbox there.
- **Anthropic**: API key via Settings → AI (stored in the Keychain).

Go-live checklist: `.scratch/p3-07-cloud-golive-acceptance/ISSUE.md`.

## Where things are

- `src/lib/server/` — db, plaid adapter, sync engine, categorizer, transfers,
  balances, corrections, ledger/search/CSV, gmail + matcher + resolution
  (receipt pipeline), proposer, digest + insights (pure money-path modules have
  tests alongside as `*.test.ts`; gmail/LLM tested against fakes)
- `src/lib/server/llm.ts` — the `Llm` seam every Anthropic call goes through;
  models are settings (`proposer_model`, `narrator_model`)
- `src/routes/` — the 9 surfaces; `src/lib/halo.css` — Halo design system
  (copied from `~/Projects/resources/halo`)
- `.scratch/` — local issue tracker (see `docs/agents/issue-tracker.md`)
