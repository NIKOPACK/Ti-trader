# Changelog

All notable changes to `@earendil-works/ti-trading-risk` are documented in this file.

## [Unreleased]

### Added

- Extracted the trading risk-control mechanism (`RiskLedger`, reservation accounting, risk state contracts, and `RiskConfig`) out of `@earendil-works/ti-trading-engine` into an independently buildable and releasable package.

### Changed

- Shared the daily-notional exceeded message between `check` and `reserve`.
- Replaced `TradingEngineConfig` with `RiskConfig` (`mode`, `marketType`, `quoteCurrency`, limits) and renamed `EngineClock` to `RiskClock`. Position mode is not part of the ledger.
- Paper daily-quota errors say the quota resets via `reset()`, without referring to ti-trader commands.
