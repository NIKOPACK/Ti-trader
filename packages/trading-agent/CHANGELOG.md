# Changelog

All notable changes to `ti-trader` are documented in this file.

## [Unreleased]

## [0.1.3] - 2026-08-27

### Added

- Added Paper support for simultaneous spot and Binance USDⓈ-M futures markets with independent accounts.
- Added Paper futures position accounting for leverage, margin mode, weighted average entry, realized/unrealized PnL, fees, partial closes, full closes, and reversals.
- Added market-family routing and validation for spot and futures market data.
- Added GitHub CI, dependency update configuration, contribution templates, and secret scanning.
- Documented live-trading loss risks and minimum API-key permissions.

### Changed

- Improved trading transcript cards (`/balance`, `/positions`, `/orders`, `/trades`, `/markets`) with adaptive borders, visible-width-aware Chinese alignment, and status colors.

### Fixed

- Declared `@earendil-works/pi-tui` as a runtime dependency so globally installed packages work outside the monorepo.
- Pinned the `@earendil-works/pi-coding-agent` runtime dependency to the tested version.
- Fixed Paper futures balance persistence, reset behavior, order identifiers, and strict futures symbol validation.
- Fixed `closePosition` handling for futures orders.
- Fixed trading transcript cards rendering with misaligned top, side, and bottom borders.
- Fixed Chinese column headers misaligning with numeric columns due to byte-length padding.
- Fixed the published package missing its direct `@earendil-works/pi-tui` dependency.
- Colored negative PnL, market change percentages, and buy/sell sides instead of only positive PnL; LIVE mode switches show a warning tone.

## [0.1.1] - 2026-08-27

### Added

- Added configurable Chinese and English TUI language selection via `/language`.
- Added menu-based configuration for trading mode, exchange, risk, paper account, and monitor commands.
- Improved balance cards with clear Available/可用余额, Locked/冻结余额, and Valuation/估值 labels.
- Added a trading status indicator showing mode, exchange, quote currency, and language.

### Changed

- `/login` now provides model-provider and exchange login menus.
- Removed the `/keys` command; exchange credentials are configured through `/login`.
- Improved trading transcript cards with borders and status colors.

## [0.1.0] - 2026-08-27

Initial public release.

### Added

- `ti` CLI: interactive TUI and `--print` headless mode, built on the pi agent harness
- Native trading tools: market data (`get_price`, `get_klines`), account (`get_balance`, `get_positions`, `get_open_orders`, `get_order_history`), execution (`buy`, `sell`, `cancel_order`), brackets (`place_oco`), risk query (`get_risk_status`)
- Paper trading engine with real market data, fees, average-entry cost, PnL, and cross-process persistence
- Live trading via ccxt (100+ exchanges); API keys stored locally in `~/.ti/agent/keys.json` (mode 600)
- Conditional orders in paper and live mode: `stop`, `stop_market`, `take_profit`, `take_profit_market`, `trailing_stop_market`, OCO brackets
- Binance USDⓈ-M futures (live only): leverage, margin mode, position mode, `reduceOnly`, funding rate
- Risk layer enforced at runtime: per-order and cumulative notional caps, symbol allowlist, live-order confirmation, headless live-order protection
- Background order monitor and position guard (unprotected-position and loss-threshold alerts that wake the agent)
- Trading slash commands: `/balance` `/positions` `/orders` `/trades` `/markets` `/mode` `/exchange` `/risk` `/keys` `/paper` `/monitor`
- Coding tools disabled; system prompt fully replaced with a trading-domain prompt
- Configuration and state under `~/.ti/agent/`, isolated from the pi coding agent's `~/.pi`

[Unreleased]: https://github.com/NIKOPACK/Ti/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/NIKOPACK/Ti/compare/v0.1.2...v0.1.3
[0.1.1]: https://github.com/NIKOPACK/Ti/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/NIKOPACK/Ti/releases/tag/v0.1.0
