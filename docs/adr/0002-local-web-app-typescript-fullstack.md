---
status: accepted
date: 2026-07-04
---

# Local web app, TypeScript full-stack (SvelteKit), native shell deferred

## Context and Problem Statement

Single owner, one machine, local-only (see [ADR-0001](0001-local-only-data-with-scoped-egress.md)).
The app is graph-heavy, so it needs a web frontend regardless; putting the backend in the
same language avoids a two-toolchain split for what is arithmetic-grade analytics. What
stack and shell should the app use?

## Considered Options

* One SvelteKit app in TypeScript, browser-served, native shell deferred
* Python (FastAPI) backend + separate JS frontend
* Native app (Electron/Tauri) from day one

## Decision Outcome

Chosen option: one **SvelteKit** app in **TypeScript** — server routes handle Plaid sync,
Gmail OAuth, the Anthropic call, and SQLite (`better-sqlite3`); pages render the UI and
charts (**Observable Plot**). No auth (localhost, single user). Detectors and Projections
are SQL + arithmetic, not a data-science stack.

**Secrets** (Plaid access tokens, Gmail refresh tokens, API keys) live in the **macOS
Keychain**, never in the SQLite file or the repo. All financial data stays in a local
SQLite file on disk.

**Native shell (Tauri) is deferred**, not rejected. The same web UI drops into a Tauri
wrapper unchanged; we pay for packaging/signing only if the browser-tab experience becomes
a real annoyance.

### Consequences

* Good, because the app runs when the owner opens it — sync on launch + manual refresh,
  optional scheduled daily pull. There is no always-on server to attack or maintain.
* Good, because going native later is additive (wrap the existing UI), not a rewrite.

## Pros and Cons of the Options

### Python (FastAPI) backend + separate JS frontend

Rejected: two languages, two dependency trees, and a hand-maintained client/server type
boundary, buying nothing for arithmetic-grade analytics. Reconsider only if the owner's
fluency strongly favors Python.

### Native app (Electron/Tauri) from day one

Rejected: both render web UIs anyway, so it only adds packaging, signing, and notarization
overhead to a one-user app.
