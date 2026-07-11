# Money Tracker

Local-first personal finance tracker. Read `PLAN.md` for the locked plan,
`CONTEXT.md` for the domain glossary, `docs/adr/` for decisions.

## Run

- `npm run dev` → http://localhost:5273 (fixed port; owner uses `PLAID_ENV=production npm run dev`)
- `npm test` (vitest, money-path modules) · `npm run check` (svelte-check)

## Agent skills

Per-repo configuration for the engineering skills (to-issues, to-prd, triage,
diagnose, tdd, improve-codebase-architecture, zoom-out):

- **Issue tracker**: GitHub Issues (`danielgentile22/money-tracker`) via `gh`; external PRs not triaged — see [.claude/agents-config/issue-tracker.md](.claude/agents-config/issue-tracker.md)
- **Triage labels**: canonical names, no overrides — see [.claude/agents-config/triage-labels.md](.claude/agents-config/triage-labels.md)
- **Domain docs**: single-context (`CONTEXT.md` + `docs/adr/`) — see [.claude/agents-config/domain.md](.claude/agents-config/domain.md)

## Dev facts (as-built; learned the hard way across three build sessions)

- **Treat the DB as live data.** The local DB (`~/Library/Application Support/Money
  Tracker/money.db`) holds live financial data: never commit it, never
  paste merchant/amount rows into a transcript (aggregate counts only), clean up
  anything you write into it. Secrets are Keychain-only (service `money-tracker`);
  never echo them.
- **Port 5273, strictPort.** Stopping the dev-server task can orphan vite —
  `lsof -ti :5273 | xargs kill` before restarting. Default `npm run dev` is
  sandbox env, which paints a cosmetic "degraded" Connection mark (p2-14;
  self-heals on a production sync); the owner runs `PLAID_ENV=production npm run dev`.
- **Migrations apply on server boot** — restart after adding one; don't trust HMR.
- **LLM code goes through the `Llm` seam** (`src/lib/server/llm.ts`); tests use
  fakes/canned replies and never touch the SDK. Load the claude-api skill before
  editing LLM plumbing — don't code model ids/params from memory.
- **Receipt sweep is cheap by design**: charges already older than the retry
  window exhaust *without* querying Gmail, so enrollment day fires zero API calls
  for the backlog. Old charges use the per-row lookup button on /transactions.
  A backlog full of "no receipt found" is correct behavior, not a bug.
- **Review-queue keyboard focus** rides `sessionStorage` across the plain-form
  POST reload. Adding `use:enhance` to those forms breaks the focus-advance trick.
- **Playwright MCP**: a stale `mcp-chrome-*` process locks the browser profile
  ("Browser is already in use") — `pkill -f 'ms-playwright-mcp/mcp-chrome'`, retry.
- **Owner gates**: p2-13 (Phase 2 acceptance), p3-07 (cloud go-live + v1 sign-off),
  and the phase-2/3 PRDs stay open until the owner explicitly closes them.
- **Parallel sessions share this one checkout** — no worktrees by default. Two agents
  on different branches will trip over each other (HEAD switches, stashes round-tripping
  the other's files). Run slices sequentially or use git worktrees/`EnterWorktree`.
- **Destructive DB testing**: set `MONEY_TRACKER_DATA_DIR` (read in the server db module)
  to point a second dev server (e.g. port 5274) at a scratch copy of the data dir. The
  real DB never gets written in tests.
- **Form actions are curl-able**: POST to `/route?/action` with an
  `Origin: http://localhost:<port>` header.
- **Don't annotate a SvelteKit action factory `(): Actions`** — it erases per-action
  return types and the route's `form` prop loses fields; use `satisfies Actions` on the
  returned object (`ledgerActions` does it right; `savedReportActions` predates this).
- **Component tests**: vitest has two projects — `server` (node, `*.test.ts`) and
  `component` (jsdom, `*.svelte.test.ts`, `$app/*` aliased to `src/test/app-state-stub.ts`).
  jsdom lacks `dialog.showModal`; polyfill in `beforeEach` (see `Ledger.svelte.test.ts`).
- **Playwright MCP snapshots** land in `.playwright-mcp/` and contain real merchant/amount
  rows — delete them after browser verification.
