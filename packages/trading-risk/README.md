# Ti Trading Risk

`@nikopack/ti-trading-risk` is the framework-independent trading risk-control package used by Ti. It owns the `RiskLedger`: per-order and daily notional limits, symbol allowlists, and atomic in-flight reservations backed by a caller-provided durable `RiskStateStore`.

The ledger is independent of exchange adapters, persistence formats, prompts, and UI. Applications supply a `RiskConfig` (mode, market type, quote currency, and limits), a state store with an atomic `transact()`, and optionally a `RiskClock`; the ledger enforces quotas and settles reservations exactly once. Position mode and other engine identity belong to the caller.

`RiskLimits.account` is optional. When present it is a complete `AccountRiskLimits` object: gross/net/asset exposure, leverage, margin usage, data age, price deviation, depth, liquidation distance, protection coverage, stop distance, and `cancelEntriesOnBreach` / `reduceOnBreach`. The package evaluates those facts (`assessAccountRisk`) and persists hard-loss trips; the engine supplies account snapshots, performs the same rules at preview and final admission, and owns mutations. Opening-flow limits (`maxOrderNotional`, `maxDailyNotional`, `allowedSymbols`) remain separate from current exposure.

## Behavior

- `check(symbol, notional)` validates an order against `maxOrderNotional`, `maxDailyNotional` (used plus reserved), the quote currency, and `allowedSymbols` without mutating state.
- `reserve(symbol, notional)` atomically claims daily quota and returns a single-use reservation; `commit()` settles the claim into used quota, `release()` returns it. Persistence failures after exchange submission surface as `RiskCommitError` with reconciliation metadata. `listPendingReservations()` enumerates unresolved claims; `reconcileReservation(id, outcome)` commits or releases a standalone retained claim by id without trusting a caller-supplied notional. Quota settlement neither resends an order nor proves the original request was rejected.
- Live-mode daily usage resets automatically at the UTC day boundary; in-flight reservations carry over into the next day. Paper-mode usage only resets via an explicit `reset()`.
- Corrupt or inconsistent persisted state fails closed with `RiskReservationStateError`.

## Shared execution accounting

Execution-aware stores also preserve journal-linked reservation identities, entry blocks, maintenance state, admission generations and bounded audit records. Their transactions must retain the full combined snapshot, not copy only the two quota counters.

A reservation linked to an execution must settle atomically with its journal record through the trading engine. `reconcileReservation` rejects attempts to settle such a claim independently. Legacy standalone reservations retain their previous reconciliation path. Unresolved execution blocks span both modes; accounting cannot turn an unknown submission into proof that no order exists.

Call `assertNewExposureAllowed()` again after any asynchronous confirmation and immediately before starting an entry submission. Do not repeat `check()` there: that would count the submission's own reservation twice. If this final admission check fails, release the unsubmitted reservation and surface the failure. This is not an atomic transaction with an exchange; an already-started submission cannot be recalled.

The caller may use `countTowardsDailyLimit: false` only for independently validated exposure-reducing orders. These bypass daily quota, but not symbol validation, allowlists or per-order limits. The ledger does not classify positions or cancel outstanding orders.

Leftover `newExposurePause` records from older writers are ignored and dropped on the next durable write.

The package is independently buildable, testable, and packable:

```bash
npm --prefix packages/trading-risk run build
npm --prefix packages/trading-risk run test
npm pack --dry-run --workspace packages/trading-risk
```

## Release order

Release and publish this package before `@nikopack/ti-trading-engine`, which depends on it with an exact version. Real npm publication is a maintainer action and is not performed by local migration work.
