# Splits schema lives outside the migration chain

**Status:** accepted (documents as-built behavior) · **Date:** 2026-07-11

The core schema evolves through a numbered migration chain (22 migrations, SQLite
`user_version`, applied at server boot). The Cost Splits feature does not: its three
tables (`split_charges`, `split_periods`, `split_payments`) are created by
`ensureSplitSchema` (`src/lib/server/split-usage.ts`), a block of idempotent
`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` statements that runs when
the `/splits` route module loads.

The feature was built directly against the owner's live database, so its tables
already existed before any migration could have created them. Retro-fitting a
positional migration would have meant a migration that is a no-op on the machine the
feature shipped on but load-bearing everywhere else — two different code paths
pretending to be one.

## Fresh installs

The in-code justification ("tables predate their slot") describes the owner's machine;
a fresh clone has no such history. Fresh installs are still correct, just lazy: the
tables don't exist until the first visit to `/splits`, at which point the module loads
and `ensureSplitSchema` creates all three from scratch. The invariant that makes this
safe is **all reads and writes of these tables live behind the `/splits` route** —
no other module queries them, so there is no window where another surface can hit a
missing table.

## Considered options

- **Join the migration chain with a `CREATE TABLE IF NOT EXISTS` migration.** Rejected —
  on databases where the tables already existed, `user_version` would then claim the
  chain created them; conditional migrations erode the chain's one guarantee (version N
  means exactly migrations 1..N ran).
- **Renumber/backfill `user_version` on the owner's DB to absorb the tables.** Rejected —
  hand-editing the version pointer on live financial data to satisfy tooling aesthetics.
- **Recreate the tables via migration and copy data across.** Rejected — churn on live
  data for zero behavior change.

## Consequences

- **Schema changes to these tables must be additive forever**: new `IF NOT EXISTS`
  statements only, never `ALTER` — there is no version pointer to gate an ALTER on, so
  it would re-run (and fail or double-apply) on every load.
- Any new consumer of splits data outside the `/splits` route must call
  `ensureSplitSchema` first, or the fresh-install laziness above becomes a bug.
- The full rationale used to live only in a comment; the comment now points here.
