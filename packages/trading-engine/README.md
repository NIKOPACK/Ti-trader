# Ti Trading Engine

`@nikopack/ti-trading-engine` is the framework-independent trading domain package used by Ti and other applications. It owns normalized exchange contracts, ccxt and paper adapters, order planning, protection logic, and `TradingEngine` orchestration. Risk control (limits, usage accounting, and reservations) lives in `@nikopack/ti-trading-risk`; the engine depends on it, owns `TradingEngineConfig`, maps that to `RiskConfig`, and re-exports risk types.

The engine does not depend on the Ti agent, LLM runtime, TUI, or extensions. It may depend on the exchange SDK (`ccxt`). Applications provide configuration, the orchestration state store and user-facing policy. The engine remains independent of prompts and user-interface concerns.

## Public surface

The package exports normalized types and contracts for market data, balances, positions, orders, conditional orders, OCO orders, and contract metadata. It provides:

- `CcxtExchangeClient` for live exchange access through ccxt. Venue-specific lookup, placement and credential policy lives in `src/venues/` profiles (`resolveLiveVenue`); unknown ids stay experimental;
- `PaperExchangeClient` for local paper accounts driven by public market data. Paper Futures simulates market, limit, stop, take-profit and trailing orders against public prices, including reduce-only protection, and applies a configurable maintenance-margin liquidation boundary. It does not model exchange-specific risk tiers, liquidation fees, bankruptcy or insurance funds, funding payments/rates, slippage, partial fills, or futures OCO. Funding queries therefore return an omitted `rate` (current value) or an empty history to represent unavailable data, not a zero rate;
- shared order planning for amount/notional resolution, market-family and contract-unit validation, and trigger checks;
- risk accounting with atomic reservations and mode-specific usage state, provided by `@nikopack/ti-trading-risk`;
- protection predicates and coverage helpers for stop-loss and related orders;
- `TradingEngine` for planning, risk checks, confirmation policy, submission, and reservation settlement.

`TradingEngine` fixes the identity of its client (`id`, `mode`, and `quoteCurrency`). Safe mutable policy updates must not make that identity or its planning context disagree with the client. Exchange, mode, market family, and quote-currency changes are performed by replacing the client and engine at the application runtime boundary.

## Safety and execution

Paper mode is the safe default in Ti. Paper Futures only applies a simplified maintenance-margin liquidation boundary; it does not model exchange-specific liquidation behavior, funding, slippage, or partial fills, so its results must not be interpreted as a realistic leveraged-trading simulation. Live execution requires exchange credentials and an explicit submission policy: callers must provide `confirm` or deliberately opt in with `allowUnconfirmedLive` for a headless workflow. Risk limits are enforced by the engine rather than treated as an LLM prompt convention. Confirmation cancellation and definite submission rejection release reservations atomically with the journal result. Unknown submission or failed post-submission persistence retains unresolved execution evidence and its claim; do not retry the original order.

`engine.risk.pauseNewExposure(reason)` persists a mode-scoped block on new exposure. Entry admission checks run before preflight, inside risk reservation, and after confirmation immediately before the exchange submission starts. A pause set during confirmation releases the unsubmitted claim; it does not consume a successfully released plan. Storage-read failures also block new entries. Validated spot sells, sell OCOs and futures reductions remain available under their existing limits and confirmation policy, as do cancellations.

Applications must obtain authorization before `engine.risk.resumeNewExposure(capturedPauseId)`. Resume requires a matching current pause ID and no unsettled claims in that mode. See the [risk API contract](../trading-risk/README.md#persistent-new-exposure-pause). The pause does not cancel existing orders, undo a submission that already started, or block account-level leverage/margin changes. All processes sharing the risk store must run a pause-aware version.

## Durable execution contract

Standalone callers must explicitly configure the fifth constructor argument:

```ts
const engine = new TradingEngine(config, exchange, combinedStore, undefined, {
	accountId: "stable-nonsecret-account-identity",
	durability: "durable",
	admissionGeneration,
});
```

`combinedStore` must atomically retain the complete risk, execution, audit and maintenance state. Declaring `durability: "durable"` does not make an in-memory or unsafe custom store durable. Ti's runtime supplies its synchronized file implementation automatically. `durability: "memory"` is an explicit offline test choice, not restart recovery.

Capture `admissionGeneration` from the validated combined state **before loading configuration or constructing the client asynchronously**. A valid legacy state without a generation starts at zero; a failed state read must not default to zero. Do not fetch the latest generation after client construction to make an obsolete configuration appear current. Ti's runtime captures and checks this binding during startup.

The engine creates stable execution and client IDs before submission, including OCO list/leg IDs and quota-exempt reductions. Journal transitions and quota settlement share a transaction. Unresolved executions block new entries across the store independently of manual pause state; existing orders are not canceled. Durable maintenance fences serialize account replacement/reset against submissions.

Admission generations fence obsolete runtimes after successful maintenance, even in another process. `getExecutionStatus().admission.stale` distinguishes this condition from an unconfigured journal. Reinitialize stale runtimes and discard their plans; account identity and historical execution scope remain unchanged.

Paper account transactions synchronize their transaction marker, both ledger snapshots and directory updates before reporting completion. Runtime reset does not clear quota or maintenance before this succeeds. This relies on the filesystem honoring synchronization and atomic rename; an abandoned Paper lock requires verified operator cleanup, not age-based takeover.

`getExecutionScope()` returns a clone of the captured account scope. `getExecutionStatus()`, `listExecutions()` and `listAuditEvents()` expose local state; `recoverExecutions(options?)` performs bounded correlated reads, never placement. Prepared never-sent records may be revoked atomically; started/unknown records require exchange evidence. Temporary not-found, unsupported lookup, mismatched identity or incomplete OCO/fill evidence remain unresolved. `resolveExecution(resolution)` is an explicit operator decision whose authorization and evidence policy belongs to the calling application.

Successful acknowledgements of open orders keep conservative quota accounting; later cancellation/fill observations are not automatic quota refunds. Terminal retention follows settlement order, so resolving an old execution does not immediately discard its new evidence. Manual outcome, notional and evidence reference also share the settlement's audit transaction. History and audit events are bounded, but unresolved records are not silently evicted. Recovery cannot reconstruct executions made outside this journal.

The shared `getTradingCapabilities()` matrix is assembled from Paper rows plus each live venue profile. It drives preview, final preflight, adapter quantity/reduction mapping and recovery lookup selection. Technical `supported` status is separate from `offline-contract`, `experimental` and `externally-verified` evidence. No externally verified integration is currently claimed; see the [capability scope](../../docs/product-readiness-plan.md#m4-executable-capability-matrix).

The engine is independently buildable, testable, and packable:

```bash
npm --prefix packages/trading-engine run build
npm --prefix packages/trading-engine run test
npm pack --dry-run --workspace packages/trading-engine
```

## Release order

Release and publish `@nikopack/ti-trading-risk` first, then the engine package. After the published engine version is available, update the exact dependency in `ti-trader`, then build and publish `ti-trader`. Real npm publication is a maintainer action and is not performed by local migration work.
