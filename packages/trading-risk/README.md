# Ti Trading Risk

`@nikopack/ti-trading-risk` is the framework-independent trading risk-control package used by Ti. It owns the `RiskLedger`: per-order and daily notional limits, symbol allowlists, and atomic in-flight reservations backed by a caller-provided durable `RiskStateStore`.

The ledger is independent of exchange adapters, persistence formats, prompts, and UI. Applications supply a `RiskConfig` (mode, market type, quote currency, and limits), a state store with an atomic `transact()`, and optionally a `RiskClock`; the ledger enforces quotas and settles reservations exactly once. Position mode and other engine identity belong to the caller.

## Behavior

- `check(symbol, notional)` validates an order against `maxOrderNotional`, `maxDailyNotional` (used plus reserved), the quote currency, and `allowedSymbols` without mutating state.
- `reserve(symbol, notional)` atomically claims daily quota and returns a single-use reservation; `commit()` settles the claim into used quota, `release()` returns it. Persistence failures after exchange submission surface as `RiskCommitError` with reconciliation metadata. `listPendingReservations()` enumerates unresolved claims; `reconcileReservation(id, outcome)` commits or releases a standalone retained claim by id without trusting a caller-supplied notional. Quota settlement neither resends an order nor proves the original request was rejected.
- Live-mode daily usage resets automatically at the UTC day boundary; in-flight reservations carry over into the next day. Paper-mode usage only resets via an explicit `reset()`.
- Corrupt or inconsistent persisted state fails closed with `RiskReservationStateError`.

## Shared execution accounting

Execution-aware stores also preserve journal-linked reservation identities, entry blocks, maintenance state, admission generations and bounded audit records. Their transactions must retain the full combined snapshot, not copy only the two quota counters.

A reservation linked to an execution must settle atomically with its journal record through the trading engine. `reconcileReservation` rejects attempts to settle such a claim independently. Legacy standalone reservations retain their previous reconciliation path. Unresolved execution blocks remain effective even when a manual pause is removed; accounting cannot turn an unknown submission into proof that no order exists.

## Persistent new-exposure pause

`pauseNewExposure(reason)` atomically stores `{ id, reason, pausedAt }` in the current mode's usage state. Reasons must contain 1 to 500 characters after trimming. `usage().newExposurePause` exposes a copy; `isRiskNewExposurePause` validates the same metadata for persistence adapters.

While paused, `check()` rejects quota-counting orders and `reserve()` checks the pause inside its atomic transaction. Existing claims can still settle; execution-linked claims use the engine's atomic settlement. `reset()`, live UTC rollover and ledger reconstruction do not remove the pause. Manual pauses cover every same-mode ledger sharing the store, not just one exchange or symbol; unresolved execution blocks independently span both modes.

Call `assertNewExposureAllowed()` again after any asynchronous confirmation and immediately before starting an entry submission. Do not repeat `check()` there: that would count the submission's own reservation twice. If this final admission check fails, release the unsubmitted reservation and surface the failure. This is not an atomic transaction with an exchange; an already-started submission cannot be recalled.

`resumeNewExposure(pauseId)` requires the currently stored ID and no unsettled reservations in that mode. Capture the ID before obtaining human authorization; a newer pause then invalidates the old authorization. The ledger does not provide a UI, so the application must enforce its own authorization and confirmation policy. Resuming does not reset quotas or relax order limits.

The caller may use `countTowardsDailyLimit: false` only for independently validated exposure-reducing orders. These bypass the entry pause and daily quota, but not symbol validation, allowlists or per-order limits. The ledger does not classify positions or cancel outstanding orders.

Every process sharing the store must understand and preserve this metadata. Stop or upgrade older writers before relying on the pause; an old binary can ignore or discard it.

The package is independently buildable, testable, and packable:

```bash
npm --prefix packages/trading-risk run build
npm --prefix packages/trading-risk run test
npm pack --dry-run --workspace packages/trading-risk
```

## Release order

Release and publish this package before `@nikopack/ti-trading-engine`, which depends on it with an exact version. Real npm publication is a maintainer action and is not performed by local migration work.
