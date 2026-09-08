# Changelog

All notable changes to `ti-trader` are documented in this file.

## [Unreleased]

## [0.1.10] - 2026-09-08

### Changed

- Pinned `@nikopack/ti-trading-engine` `0.3.0` and `@nikopack/ti-triggers` `0.1.0` after moving Ti packages out of the upstream `@earendil-works` npm scope.

## [0.1.9] - 2026-09-08

### Added

- Added `/risk pause [reason]` and interactive-only `/risk resume`, durable pause metadata, bilingual status/settings displays, and pause reporting in risk tools. Resume rejects unsettled reservations and stale runtime or pause confirmations.
- Added atomic execution records, automatic bounded startup reconciliation, confirmed `/recovery` resolution and bounded audit history, with original-account identity and persistent maintenance fences.
- Added durable scoped trigger/order-monitor baselines, cooldowns and bounded notification retries with stable delivery IDs. Live triggers and recovered/retried notifications never wake trading; fresh order/guard events retain the configured analysis wake behavior.
- Added read-only `/health`, isolated offline readiness gates, release evidence validation and operator recovery/backup procedures. Sustained Paper and authorized live acceptance remain separate requirements.
- Added an isolated package-install verifier and a Paper soak collector that write release-gate artifacts from packed tarballs and durable journal/ledger state. They do not publish or mark a seven-day run complete.

### Changed

- Smoke checks now isolate Ti data under a temporary directory by default; `TI_DATA_DIR` can select an explicit test directory. Runtime storage path derivation is centralized for repeatable tests.
- Account and market switches now require explicit confirmation when existing or unverified exchange exposure could be hidden; Paper checks both ledgers and Binance live checks both Spot and USDⓈ-M wallets.
- Runtime initialization and client replacement are transactional, repeated shutdowns are idempotent, and risk-only configuration changes roll back persisted state when engine installation fails.
- Paper settings now apply their configured start balance and fee rate, while fee-rate changes are blocked when open orders, positions, or unsettled reservations exist.

### Fixed

- Order and trigger monitors now isolate session generations, discard stale polls, retry unresolved fills with a bounded retention window, and clear position alert state after close/re-entry.
- Settings mask exchange credentials, and command/settings account-switch confirmations now have explicit interactive and headless-safe paths.
- Protection coverage counts only the remaining unfilled protective quantity, and monitor polling observes runtime interval changes without leaving a stale interval running.
- OCO execution now consumes the engine's structured preflight assessment instead of maintaining a second market and balance validation path.
- Trigger polling reports failed position or price observations while continuing to evaluate independent price and time triggers.
- Failed runtime shutdowns can be retried, including after an exchange switch, without duplicating concurrent close attempts.
- Trigger evaluation uses collection-completion time and timestamps position observations when received, preventing slow requests from losing crossings, accepting stale data, or firing expired triggers.

## [0.1.8] - 2026-09-03

### Added

- Added `/risk reconcile <id> commit|release` to settle stuck in-flight risk reservations after verifying the exchange order. `get_risk_status` now lists pending reservations, and session start warns when any remain.
- Added `/settings` as a bilingual trading settings overlay (language, mode, exchange, market, keys, risk, paper, monitor, futures).
- Documented the extracted trading-engine runtime boundary and engine-first release order.
- Added read-only `check_order`, `get_trading_capabilities`, `get_top_markets`, and `get_portfolio_snapshot` tools for controlled order planning, capability discovery, market candidates, and account reconciliation.
- Added market-lab `evaluate_strategy` presets (`ema-cross`, `rsi-revert`, `macd-hist`) and optional indicator periods. Analysis remains non-binding and does not place orders.
- Default `ti` sessions now load the bundled market-lab extension (`calculate_indicators`, `analyze_market_structure`, `generate_trade_signal`, `evaluate_strategy`, `/indicators`, `/signal`).
- Added market-lab `screen_markets` (up to 8 spot symbols) and `simulate_rule` (closed-candle preset replay). Both are analysis-only and do not place orders.

### Changed

- CLI `--mode` and `--exchange` overrides coerce an incompatible stored `marketType` to `spot` for the session only and rewrite `risk.allowedSymbols` to the spot family. Interactive `/exchange`, `/market`, `/mode`, and `/settings` still fail closed and do not persist a silent rewrite.
- Live `/trigger` `wake_agent` actions notify only and no longer start an agent turn. Price facts use the ticker timestamp instead of poll time, so stale quotes do not fire.
- Deduplicated live account-change confirmation, order/OCO placement failure handling, market-info matching, and contract-stats serialization in trading tools.
- Empty `/` slash suggestions now pin a short trading list; remaining commands stay available when typed.
- `/language`, `/mode`, `/exchange`, `/market`, `/risk`, `/paper`, `/monitor`, and `/exchange-login` open `/settings` when invoked without arguments.
- Unified buy/sell order intent validation and amount/notional resolution behind a shared read-only order planner.
- Paper market discovery now uses the configured market family, including USDⓈ-M futures in futures mode and both families in both mode.
- Balance and funding outputs mark unavailable or simulated values explicitly instead of presenting them as reliable zeroes.
- Order preflight keeps missing market, balance, or contract-unit evidence as blocking `unknown`; live futures fee and maintenance-margin data are an explicit non-blocking warning, so a reviewed `ok_with_warnings` result may proceed while the exchange remains authoritative.
- Futures amounts are base-unit values at the agent boundary and are converted through the market `contractSize` to exchange contracts; unsafe or non-representable metadata is rejected instead of guessed.
- Close-all trigger previews and results now distinguish the requested matching-position amount from an exchange quantity that Binance may omit.
- OCO risk accounting now separates observed notional from conservative worst-case leg risk.
- Live order confirmation, including headless no-UI rejection, now runs inside the engine reservation (`policy.confirm`) so a failed confirm releases quota instead of confirming before reserve.
- CLI version is read from `package.json` instead of a duplicated constant.
- Trading mode, market-type, risk-limit, and credential types are re-exported from the trading engine.
- Split trading tool helpers into schema, capability, format, and execution modules; `tools/shared.ts` remains the import path.
- Position guard evaluates protection coverage once per open order instead of calling `isProtection` and `protectionCoverage` separately.

### Fixed

- Persisted risk state now round-trips in-flight reservations instead of dropping them on a typed save.
- Flattened `check_order` tool parameters into a single JSON Schema object so providers that reject or ignore `allOf` (Kimi, GLM flash) can still call the tool.
- Futures exchange-amount checks use `amountStep` when present so Binance TICK_SIZE lots match paper and live submission.
- Futures `quoteAmount` previews now snap to an exchange-representable contract lot so `check_order` cannot return ok for an amount `buy` would reject.
- Fixed preflight selecting the spot wallet for futures orders in Paper both mode and added Paper futures margin checks.
- Prevented ignored order fields and immediately-triggering stop/take-profit orders from producing misleading previews.
- Prevented capability fallbacks from claiming support for disabled, invalid, or unverified markets.
- Serialized Paper account settlement and mutations, enforced market-family guards, and de-duplicated shared OCO exposure.
- Enforced hedge-mode reduction direction (`LONG` + sell, `SHORT` + buy) before submission. Binance live USDⓈ-M now reports `reduceOnlyApplied: false` and its exchange constraint when it must omit wire-level `reduceOnly`; Paper and other adapters retain the explicit flag.
- Filled orders no longer display `cost: 0` / missing average as if those were observed fill economics.

## [0.1.7] - 2026-09-01

### Changed

- Split trading tools into market, account, order, and futures-management modules.
- Paper mode now writes the simulated ledger under the configured `PAPER_DIR`.
- Trading-state file locking now uses the engine's shared lock helper.

### Fixed

- Documented the experimental `/trigger` monitor that is already registered by `ti-trader`.

## [0.1.6] - 2026-08-29

### Added

- Added `set_multi_assets_mode` to disable Binance Multi-Assets mode before configuring isolated margin.

## [0.1.5] - 2026-08-28

### Added

- Added Pi Package metadata for installing the published market analysis, research, web search, and Zhihu extensions with the market research skill.
- Added a read-only Zhihu global web search extension using the official OpenAPI, with URL-encoded filters, index selection, source metadata, and secret-safe error handling.
- Added `/zhihu-login` with masked TUI input and private local Access Secret storage.

### Changed

- Ti package discovery now prefers `ti` manifests with a Pi-compatible fallback, and refreshes the trading prompt from the active runtime configuration before each agent turn.

### Fixed

- Added Binance Spot native trailing-stop orders using `trailingDelta` and clarified Spot OCO/trailing-stop support.
- Fixed atomic risk accounting, paper/live quota isolation, futures position semantics, order status/history handling, and position-monitor retries.
- Fixed bundled extension entry paths, candle/indicator edge cases, and research/search cancellation and endpoint isolation.
- Fixed Ti TUI branding so the interactive header, terminal title, and runtime messages use Ti instead of Pi.

## [0.1.4] - 2026-08-28

### Added

- Added read-only market research, technical indicator, and web search extensions.
- Added futures market metadata and funding-rate history tools.

### Fixed

- Prevented protective sell orders and OCO exits from consuming entry risk quota.

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

[Unreleased]: https://github.com/NIKOPACK/Ti/compare/v0.1.10...HEAD
[0.1.10]: https://github.com/NIKOPACK/Ti/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/NIKOPACK/Ti/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/NIKOPACK/Ti/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/NIKOPACK/Ti/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/NIKOPACK/Ti/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/NIKOPACK/Ti/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/NIKOPACK/Ti/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/NIKOPACK/Ti/compare/v0.1.2...v0.1.3
[0.1.1]: https://github.com/NIKOPACK/Ti/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/NIKOPACK/Ti/releases/tag/v0.1.0
