# Changelog

All notable changes to `@earendil-works/ti-trading-engine` are documented in this file.

## [Unreleased]

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
