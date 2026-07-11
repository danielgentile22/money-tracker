# Money is integer cents; the one float in the money path is a ratio

**Status:** accepted (documents as-built behavior) · **Date:** 2026-07-11

Every stored money amount in the schema is an `amount_cents INTEGER` — transactions,
budgets, balances, split charges, split payments. Arithmetic on money is integer
arithmetic; display divides by 100 at the edge. This avoids the classic float-money
failure (0.1 + 0.2, drifting sums over thousands of rows) without a decimal library.

The single deliberate exception is `split_periods` (`src/lib/server/split-usage.ts`):
`matched_cost` and `total_cost` are SQLite `REAL`. They are not money the app owes or
tracks — they are usage-dollar figures reported by the ccusage CLI, stored verbatim as
evidence, and used only as a **ratio**. The money output is derived as

```
attributable_cents = round(amount_cents * matched_cost / total_cost)
```

so float precision touches one multiplication and one division per period, then is
rounded back into integer cents once (a zero-usage period attributes 0 rather than
dividing by zero). Downstream math — e.g. applying the partner's share percentage —
starts from the integer `attributable_cents`, so its own rounding never compounds
with this one.

## Considered options

- **Integer cents everywhere, including usage costs.** Rejected — ccusage reports
  fractional dollar costs at whatever precision it likes; scaling them to a fixed-point
  representation adds a conversion (and a rounding) purely to avoid a float that never
  participates in money arithmetic.
- **A decimal library (e.g. `big.js`).** Rejected — one dependency to protect one
  division whose result is immediately rounded to a cent is not worth the surface area.
- **Allocate residual cents (largest-remainder style) across periods.** Rejected —
  periods are independent attributions of independent charges, not shares of one pot;
  there is no invariant that attributions sum to anything.

## Error and drift bound

Per period the only rounding is the final `Math.round`, so the attribution error is at
most half a cent, and IEEE-754 double error on `amount_cents * matched / total` (values
≪ 2^53) is orders of magnitude below that. Errors do not compound: each period is
computed from its own charge and its own usage window, never from a previous period's
rounded output. If anyone ever sums attributions, the worst-case rounding error over
N periods is N/2 cents — for a monthly subscription, under a dime a year. The residual
(charge minus attributable) is simply the un-attributed remainder of the charge, kept
by the owner by design rather than allocated anywhere.

## Consequences

- `matched_cost`/`total_cost` stay owner-visible on the splits page as the audit trail
  for each attribution; the stored `attributable_cents` is what the ledger reasons about.
- Any future consumer of `split_periods` must treat the REAL columns as evidence, not
  money — new money math starts from `attributable_cents`.
