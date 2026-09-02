# Ti Trading Risk

`@earendil-works/ti-trading-risk` is the framework-independent trading risk-control package used by Ti. It owns the `RiskLedger`: per-order and daily notional limits, symbol allowlists, and atomic in-flight reservations backed by a caller-provided durable `RiskStateStore`.

The ledger is independent of exchange adapters, persistence formats, prompts, and UI. Applications supply a `RiskConfig` (mode, market type, quote currency, and limits), a state store with an atomic `transact()`, and optionally a `RiskClock`; the ledger enforces quotas and settles reservations exactly once. Position mode and other engine identity belong to the caller.

## Behavior

- `check(symbol, notional)` validates an order against `maxOrderNotional`, `maxDailyNotional` (used plus reserved), the quote currency, and `allowedSymbols` without mutating state.
- `reserve(symbol, notional)` atomically claims daily quota and returns a single-use reservation; `commit()` settles the claim into used quota, `release()` returns it. Persistence failures after exchange submission surface as `RiskCommitError` with reconciliation metadata. `listPendingReservations()` enumerates unresolved claims; `reconcileReservation(id, outcome)` commits or releases a retained claim by id without trusting a caller-supplied notional. Do not retry the original submission until that claim is settled.
- Live-mode daily usage resets automatically at the UTC day boundary; in-flight reservations carry over into the next day. Paper-mode usage only resets via an explicit `reset()`.
- Corrupt or inconsistent persisted state fails closed with `RiskReservationStateError`.

The package is independently buildable, testable, and packable:

```bash
npm --prefix packages/trading-risk run build
npm --prefix packages/trading-risk run test
npm pack --dry-run --workspace packages/trading-risk
```

## Release order

Release and publish this package before `@earendil-works/ti-trading-engine`, which depends on it with an exact version. Real npm publication is a maintainer action and is not performed by local migration work.
