# Changelog

All notable changes to `@nikopack/ti-trading-engine` are documented in this file.

## [Unreleased]

## [0.4.0] - 2026-09-20

### Breaking Changes

- Stopped exporting `countsTowardsDailyLimit` and `futuresContractLotStep`. Both remain internal to order planning.
- Stopped re-exporting `pauseNewExposure` types and helpers. Entry admission no longer consults a manual pause; unresolved executions, quota and account-risk checks remain.

### Added

- Optional immutable execution references and synchronous final reference validation for ordinary/OCO submissions. Referenced records survive ordinary history pruning until exact-revision archival; open linked orders retain read-only correlated refresh support.
- `OrderFeeObservation` preserves actual original-currency charges, signed rebates, source and completeness through Paper persistence, correlated venue lookup, recovery and archival. `observedExecutionFee` aggregates only complete, terminal, correctly sourced quote charges; legacy scalars remain untrusted.
- `Ticker.sourceTimestampKnown` distinguishes venue timestamps from local fallbacks in live and Paper market data.
- `CcxtExchangeClient.reloadMarkets()` refreshes the process-cached markets snapshot so long-running processes can pick up newly listed symbols and changed filters.
- Re-exported `assessProtectionTarget` and `assessLeverageSetting` from `@nikopack/ti-trading-risk` alongside the other account-risk assessors.
- Account-wide hard-risk admission, stable intent identities, unknown-only running recovery, persistent protection targets and independent supervision. Paper supplies atomic account snapshots and atomic stop replacement/protected closure.
- Pending cancellation/settings identities and verified-dead local lock recovery retain execution state across interrupted operations.

- Paper futures now simulates limit, stop, take-profit and trailing orders with the same lazy kline-backfill matching as Paper spot. Reduce-only and closePosition orders lock the matching position; opening orders reserve quote margin. OCO, funding payments, slippage and exchange-specific liquidation remain out of scope.

### Changed

- Pinned `ccxt` `4.5.77` and fail closed when ccxt omits market metadata, order ids, or precision strings.
- Submission failures are now classified by a single `isDefiniteSubmissionRejection` implementation shared by order, trailing and OCO submission paths (previously two diverging copies in `ccxt-client.ts` and `ccxt-map.ts`). Explicit venue business errors (`BadRequest`, `ArgumentsRequired`, `OperationRejected`, `NotSupported`, `PermissionDenied`, Binance codes -2014/-2015/-2021) that only one copy recognized are now definite rejections; duplicate-order replies are now uncertain so the client-order-id recovery lookup returns the already-accepted order.

### Fixed

- After a human confirmation, material changes to price, risk notional or capability warnings generate a new summary and require another confirmation instead of submitting the originally confirmed snapshot. Invalidating changes, TTL expiry, the confirmation-prompt bound and unattended drift beyond 1% still fail closed without calling the adapter.
- Package `repository`, `homepage` and `bugs` now point at [NIKOPACK/Ti-trader](https://github.com/NIKOPACK/Ti-trader).
- Prepared ordinary and OCO plans expire 60 seconds after `prepare` using the engine clock, not the venue ticker timestamp. Each market/account revalidation round checks TTL before and after its I/O; confirmation is the only reason a second round runs. Confirmation revalidation does not replace the account-risk generation minted by `journal.prepare()`. An expired or generation-changed plan releases the reservation, does not call the adapter, and requires a new prepare/confirm. Clock rollback fails closed.
- Unchanged execution polling no longer creates archive revisions for timestamp/source-only changes or alters settled quota. Actual order parameters and late observed fees remain revisioned.
- Resting Paper fills retain cumulative economics and persist actual charged fees against the canonical order ID, without reconstructing fees from current settings.
- Stale-timeout lock reclamation now serializes through the `.reclaim` gate like dead-owner recovery, closing a race where two waiters that both observed a stale lock could unlink each other's replacement lock and both believe they hold it. A fresh lock installed by another reclaimer is no longer removed.
- Live order and order-list cancellation without account hard risk no longer removes stop-flavored exits that protect an open position; the cancellation fails closed like the account-risk guard and directs the operator to a controlled close. `isProtectiveExit` is exported and `verifiedReducingOrder` accepts a position-mode-only scope. A target missing from the open-orders snapshot is looked up before cancelling; an unproven identity is refused rather than treated as unprotected.
- A stable `intentId` that settled as a `release` (confirmation cancel, pre-submission validation failure, or definite exchange rejection) can be reused with the same fingerprint. In-flight, unknown and committed identities still refuse reuse.
- Account-risk cancellation coverage now counts `stop`, `trailing_stop_market` and OCO stop legs, and compares remaining coverage by symbol and side instead of list index, so configuring `risk.account` no longer lets a live trailing or OCO stop be cancelled as unprotected.
- Paper futures now cancels leftover reduce-only orders after a one-way reverse or a partial close that no longer fits, instead of leaving a stop that can deadlock settlement.
- Opening trailing sells top up reserved margin as the peak rises, and a leverage drop re-reserves resting opening orders. A working opening order stays open when a fill cannot be margined.
- Cross-margin liquidation counts reserved opening-order margin as equity. Reducing futures limits reserve fee only, not opening margin. A closePosition stop locks the live position quantity.
- Hedge reducing orders lock the open side so overlapping closes cannot deadlock settlement. Position-mode switches with open futures orders are rejected. Leftover one-way closes re-reserve as openings. Paper preflight includes taker fee, and closePosition is limited to market/stop_market/take_profit_market.

## [0.3.3] - 2026-09-10

### Changed

- Live venue differences now live in `src/venues/` profiles, including Binance native lookup, Spot OCO/trailing, opposite-wallet probes, and Multi-Assets. `CcxtExchangeClient` delegates those operations to the resolved profile. OKX/Bybit remain experimental; unknown ccxt ids use the experimental profile.

## [0.3.2] - 2026-09-08

### Fixed

- Paper and live buy/sell plans now truncate spot amounts onto the same venue `amountStep` that both adapters already apply (`amountToPrecision` uses TRUNCATE, not round). A `quoteAmount` without a published step is rejected instead of leaving settlement to infer a paper-only lot. Explicit spot `amount` orders still prepare when market metadata is unavailable; preflight then reports unknown.

## [0.3.1] - 2026-09-08

### Fixed

- Paper and recovery now treat venue lot-rounded fills as matching the requested amount. A `notional / last` size that the adapter snaps (beyond a 1e-8 relative epsilon) no longer fails settlement as `evidence-conflict` or leave `submission-started`. Spot plans snap to `amountStep` when the market publishes one.

## [0.3.0] - 2026-09-08

### Breaking Changes

- Published the package as `@nikopack/ti-trading-engine` and pinned `@nikopack/ti-trading-risk` `0.2.0`. The `@earendil-works` npm scope is owned by upstream Pi and cannot be used for Ti releases.

## [0.2.0] - 2026-09-08

### Breaking Changes

- Order submission now requires explicit execution-journal options and an account identity; durable callers must also capture the admission generation before loading configuration or constructing clients. `TradingRuntime` provides durable defaults. Standalone callers must configure an atomic combined store; memory durability is an explicit testing choice.

### Added

- Enforced persistent new-exposure pauses before preflight, during reservation and after order/OCO confirmation, while retaining validated exits and cancellations.
- Added atomic journal/reservation settlement, stable ordinary/OCO client IDs, bounded correlated recovery, manual evidence-based resolution and maintenance fences without TTL takeover.
- Added cross-process admission generations, settlement-ordered terminal retention and durable Paper transaction synchronization before reset completion.
- Added an executable capability matrix shared by planning, preflight, adapter parameter mapping and recovery. Technical support is separate from offline versus externally verified evidence.

### Changed

- Exchange-independent order-field validation is isolated from the ccxt adapter and covered by focused unit tests, while the public order API remains unchanged.
- OCO market and balance preflight now returns a structured assessment for callers to render without duplicating exchange rules.
- Live submissions now require an explicit confirmation policy; headless callers must opt in with `allowUnconfirmedLive`.

### Fixed

- Submission failures default to status-unknown unless they are a definite business rejection (`InsufficientFunds`, `InvalidOrder`, authentication, Binance `-2010`/`-1013`/`-2021`). Transport errors such as `socket hang up`, `ECONNRESET`, `BadResponse`, and 429/418 rate limits now reconcile by clientOrderId instead of releasing risk quota.
- Live adapters reject malformed order inputs before exchange calls, require strict futures contract metadata, and refuse uncorrelated emulated client-id lookups.
- Paper account snapshots validate persisted ledger invariants, and Binance account-exposure checks inspect the opposite Spot/USDⓈ-M wallet before a market-family switch.
- Futures preflight uses the adapter's effective per-symbol leverage and Paper futures balances report used margin, equity, and mark/index-price valuation; isolated ticker failures no longer suppress cross-margin liquidation checks.
- Partially filled or unresolved live orders retain their remaining daily quota exposure, including OCO submissions and persisted risk state.
- Hedge-direction futures reductions no longer require new collateral and reject quantities beyond the matching open position.
- Paper liquidation settles cross losses against shared free collateral, limits isolated losses to their collateral, and preserves each opening lot's margin mode after settings changes. Missing position valuations now fail balance reads explicitly.
- Binance Spot trailing orders use the correct buy/sell delta bounds and take-profit activation direction, so sell orders wait for an above-market activation price.
- Paper historical settlement defers current ticks until missing candles are recovered, keeping trailing-stop state and the persisted history cursor in chronological order.
- Paper futures settle existing liquidations before new orders using a shared price snapshot, and retain those settlements even when the new order is rejected.
- Futures reductions tolerate floating-point quantity tails without allowing materially oversized closes or retaining phantom Paper position lots.

## [0.1.2] - 2026-09-03

### Added

- Extracted the exchange adapters, order planning, protection, risk accounting, and trading orchestration into an independently buildable and releasable package.
- Added production packaging metadata for the engine-first release boundary.
- Documented the independent engine boundary and engine-first publication order.

### Changed

- Extracted the risk-control mechanism (`RiskLedger`, reservation accounting, and risk state contracts) into the new `@earendil-works/ti-trading-risk` package; the engine depends on it with an exact version, owns `TradingEngineConfig`, and maps it to `RiskConfig`. `MarketType` is defined by the risk package and re-exported; `FuturesPositionMode` stays engine-local.
- Futures `quoteAmount` plans snap up to a representable contract lot and min notional; explicit off-grid amounts are rejected during prepare instead of at submission.
- Trading engine market-data reads now go through the frozen `MarketDataClient` view; order-plan reduce-side detection uses the shared protection helper.
- Paper exchange clients require an explicit account directory and reuse the shared ccxt ticker mapper.
- `risk.allowedSymbols` must match the configured quote currency and market family; an empty list still allows all symbols.
- Split paper path evaluation and live Binance Spot OCO/trailing/cost-basis helpers out of the adapter classes.
- Paper and live adapters share `contractSizeForMarket`; inverse or unidentified contracts are rejected in both.
- `isProtection` now delegates to `protectionCoverage`; a zero-size position is never treated as protected.

### Fixed

- Filled live orders now map quote cost and average from exchange `cumQuote`/`avgPrice` (or filled × average) instead of reporting `cost: 0` when ccxt leaves those fields empty. If a filled submission still has zero cost, the adapter re-fetches the order.
- Futures lot snapping now uses `MarketInfo.amountStep` from ccxt `precisionMode`. Binance USDⓈ-M `precision.amount = 1` is a 1-contract tick, not 0.1, so `quoteAmount` plans no longer preview 242.7 contracts that submit then reject.
- The read-only market-data view now delegates to the live client methods instead of binding a construction-time snapshot.

## [0.1.1] - 2026-09-01

### Added

- Added shared JSON persistence and exclusive file-lock helpers for paper ledgers and other durable state.
- Tightened persisted paper-account validation so nested orders, trades, and entries are checked before they are loaded.

### Changed

- Moved live ccxt order/ticker mapping and exchange-error normalization into a dedicated module.
- Trading engine market-data reads now go through the frozen `MarketDataClient` view; order-plan reduce-side detection uses the shared protection helper.
- Paper exchange clients require an explicit account directory and reuse the shared ccxt ticker mapper.
- `risk.allowedSymbols` must match the configured quote currency and market family; an empty list still allows all symbols.
