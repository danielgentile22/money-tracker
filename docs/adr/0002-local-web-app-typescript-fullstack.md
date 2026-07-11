# Local web app, TypeScript full-stack (SvelteKit), native shell deferred

**Status:** accepted · **Date:** 2026-07-04

Single owner, one machine, local-only (see ADR-0001). The app is graph-heavy, so it needs a
web frontend regardless; putting the backend in the same language avoids a two-toolchain
split for what is arithmetic-grade analytics.

**Decision:** one **SvelteKit** app in **TypeScript** — server routes handle Plaid sync,
Gmail OAuth, the Anthropic call, and SQLite (`better-sqlite3`); pages render the UI and
charts (**Observable Plot**). No auth (localhost, single user). Detectors and Projections are
SQL + arithmetic, not a data-science stack.

**Secrets** (Plaid access tokens, Gmail refresh tokens, API keys) live in the **macOS
Keychain**, never in the SQLite file or the repo. All financial data stays in a local SQLite
file on disk.

**Native shell (Tauri) is deferred**, not rejected. The same web UI drops into a Tauri
wrapper unchanged; we pay for packaging/signing only if the browser-tab experience becomes a
real annoyance.

## Considered options

- **Python (FastAPI) backend + separate JS frontend** — rejected: two languages, two
  dependency trees, and a hand-maintained client/server type boundary, buying nothing for
  arithmetic-grade analytics. Reconsider only if the owner's fluency strongly favors Python.
- **Native app (Electron/Tauri) from day one** — rejected: both render web UIs anyway, so
  it only adds packaging, signing, and notarization overhead to a one-user app.

## Consequences

- The app runs when the owner opens it — sync on launch + manual refresh, optional scheduled
  daily pull. There is no always-on server to attack or maintain.
- Going native later is additive (wrap the existing UI), not a rewrite.
