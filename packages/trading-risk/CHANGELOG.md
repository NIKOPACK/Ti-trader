# Changelog

All notable changes to `@earendil-works/ti-trading-risk` are documented in this file.

## [Unreleased]

## [0.1.2] - 2026-09-08

### Added

- Exported `validateTradingSymbol` so risk, order planning, and runtime configuration can share one market-symbol grammar.
- Added durable, mode-scoped new-exposure pauses with validated metadata, atomic reservation enforcement, and reservation-safe resume using the confirmed pause ID. Pauses survive restarts, quota resets and UTC rollover.
- Preserved execution-linked reservations, audit records and entry blocks in shared atomic state. Linked claims must settle with their execution record rather than through standalone quota reconciliation.

## [0.1.1] - 2026-09-03

### Added

- Extracted the trading risk-control mechanism (`RiskLedger`, reservation accounting, risk state contracts, and `RiskConfig`) out of `@earendil-works/ti-trading-engine` into an independently buildable and releasable package.

### Changed

- Shared the daily-notional exceeded message between `check` and `reserve`.
- Replaced `TradingEngineConfig` with `RiskConfig` (`mode`, `marketType`, `quoteCurrency`, limits) and renamed `EngineClock` to `RiskClock`. Position mode is not part of the ledger.
- Paper daily-quota errors say the quota resets via `reset()`, without referring to ti-trader commands.
