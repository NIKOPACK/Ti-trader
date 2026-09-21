# Changelog

All notable changes to `ti-trader` are documented in this file.

## [Unreleased]

## [0.4.0] - 2026-09-21

### Breaking Changes

- Consolidated the slash command surface. `/balance`, `/positions`, `/orders`, `/trades`, `/markets`, `/audit` and `/health` moved under `/show` (e.g. `/show balance`, `/show health`). `/indicators`, `/signal`, `/screen`, `/replay` and `/chart` moved under `/lab` (e.g. `/lab signal`, `/lab chart`). `/trigger` moved under `/monitor` as `/monitor trigger add|list|remove|clear`. The standalone `market-chart` extension merged into `market-lab`; `ti-trader` autoloads only `market-lab`.
- Settings commands invoked without arguments now print the current value and a usage hint instead of opening the settings menu: `/language`, `/mode`, `/approval`, `/exchange`, `/market`, `/paper`, `/exchange-login`, `/risk` and `/monitor`.

### Added

- Guided first-run setup behind bare `/autonomous` and `/autonomous start` on an uninitialized or incomplete account. The panel derives account scope and operational defaults, offers authenticated models and a suggested Paper hard-risk preset, requires an explicit unattended-order confirmation, then writes `trading.json` and `autonomous.json` and starts the daemon. It refuses live accounts and unavailable models instead of substituting defaults.
- Parent-side autonomous start preflight: missing configuration, absent `risk.account`, non-unattended approval, scope mismatches and live mode now fail with direct errors before the daemon forks, instead of requiring `autonomous.log` inspection.

### Changed

- `check_order` preflight now collects every market limit violation in one result instead of reporting only the first failing filter.
- `/monitor` gains an explicit `status` action; bare `/monitor` prints the same status instead of opening the settings menu.

## [0.3.0] - 2026-09-20

### Breaking Changes

- Removed unused `createGetFundingRateTool` and `createGetFuturesPositionsTool` factory exports. Current funding is `get_contract_stats`, historical funding is `get_funding_rate_history`, and futures holdings are `get_positions`.
- Removed `/risk pause`, `/risk resume` and the durable new-exposure pause. Leftover pause records are ignored. Autonomous `/autonomous pause` still stops the model loop and does not write a risk pause.

### Added

- Persistent specialist research sessions with exact history continuation, role/session discovery, cited bounded reports, paged evidence and optional batch review. Interactive ownership is parent/account-scoped; autonomous workers retain child sessions across wakes and restarts.
- Durable, account-scoped trade plans with immutable rationale versions, operator-confirmed tracking, read-only condition observations, Paper-reset invalidation, execution provenance and `/plan` reviews/exports.
- Plan-linked order and account-protection observations reuse bounded read-only recovery, durable notification leases/retries and `/health`, without waking a model. Localized paginated reviews compare frozen proposals with recorded executions; independent-install probes require cross-process plan continuity and actual evidence extension registration.
- Private decision evidence records capture public rationales, bounded numeric observations and actual mutation attempts. `/decisions` evaluates citation freshness, missing/retrospective rationale and unknown outcomes without claiming model reliability or profitability.
- Operator-frozen prospective studies collect source-timestamped endpoints within fixed windows and report declared-cost spot long/cash comparisons, missingness and non-overlapping samples. Bounded bilingual decision views stay out of model history; complete private evidence supports offline reevaluation.
- Execution reviews consume observed fee provenance, including Paper ledger charges and signed venue rebates, without treating legacy fee scalars or foreign-currency charges as complete quote costs. Late fees share bounded plan refreshes, and decision facts survive ordinary journal retention through plan archives.
- Explicit headless autonomous Paper mode with persistent events, model-controlled wakes, separate AgentSession workers, reviewed research tools, independent risk supervision and start/status/pause/resume/stop controls. Autonomous live startup fails closed until adapters provide complete account-risk evidence.
- TUI `/autonomous` controls the background runtime with account binding, subcommand completion and localized status. Pause and stop do not wait for an active model turn; exiting the TUI leaves the daemon running.

### Changed

- Subagent and `market_research` analysis budgets are unlimited by default: no implicit time, turn, tool-call, token or batch deadline. Explicit role limits remain optional; cancellation, outer runtime deadlines, concurrency and output-size protections are unchanged.
- `subagent` now includes technical, event, derivatives and strategy analysts alongside scanner, researcher and reviewer. Parent prompts delegate substantial analysis without requiring every specialist or repeating child history; `market_research` shares the persistent runtime with proposals disabled.
- Documented autonomous Paper, optional `risk.account` hard limits, live protective-cancel refusal and credential-file mode-600 tightening in the design doc, package README and operator guides.
- Startup header uses a solid block Ti wordmark in `#808080`, lists only `/`, interrupt and more, and hides Skills/Extensions unless `--verbose`.
- Native trading tools use compact, localized summaries with original parameters and output available through tool expansion. Warnings, incomplete data, order identifiers and ambiguous execution outcomes remain visible.
- Live order and OCO confirmation shows localized fields from the exact prepared plan, including price provenance, reserved quota and exchange constraints. TUI review defaults to cancellation and supports configurable paging and narrow layouts; RPC retains its confirmation protocol and submission policies are unchanged.
- Paper futures now accepts the same limit and conditional order types as Paper spot. Prompts, tool descriptions and capability output no longer describe Paper futures as market-only. Futures OCO remains unsupported.
- Trading query cards retain labeled fields and wrap narrow layouts instead of hiding order conditions or PnL. Market charts wrap Chinese explanations and use terminal display widths for styled content.
- Venue, approval and local health share one cached status region, prioritizing entry blocks and degraded observations while preserving source information. Actual observation ages refresh every five seconds without exchange requests; configuration changes refresh immediately.
- Slash completion keeps common commands first while showing all available commands. Risk limits and allowed symbols are editable in Settings; the Agent TUI row prepares its built-in settings command in the editor.
- Market-lab commands accept explicit candle limits and replay horizons. Screens retain per-symbol source, closed sample time and warnings, and distinguish partial failure, total failure and mixed market sources.
- Rule replays enter at the next candle's open after a closed-bar signal and exit at the configured candle horizon. RSI entries require an observed transition into an extreme; zero-trade statistics are unavailable rather than zero.
- Conditional changes use shared durable one-hour history with explicit baseline tolerances, including autonomous wakes. Hedge PnL facts accept explicit `LONG`/`SHORT` suffixes; ordinary trigger commands do not modify autonomous-owned triggers.

### Fixed

- Live order review shows the engine's latest confirmation snapshot when market evidence is re-quoted after the previous confirmation, including updated notional, reference price and warnings.
- The autonomous runtime no longer writes durable state three times per poll or grows it forever: the heartbeat joins the observation transaction, an idle decision skips its write, a transaction that changes nothing performs no durable write, and consumed event receipts compact while the minted-event sequence stays monotonic.
- A full autonomous event backlog no longer stops supervision and the decision loop. Repeated position, fill and risk observations fold into one pending wake of the same kind, wakes beyond the bound are dropped with explicit `coalescedEvents`/`droppedEvents` accounting plus a recorded failure, and `/autonomous status` reports both counts.
- Constructing an `AutonomousStore` no longer writes persisted state, so read-only `status` and commands cannot mutate the data directory; the daemon materializes its scope before execution recovery reads it.
- Package `repository`, `homepage`, `bugs`, changelog compare links and the OpenRouter HTTP referer now point at [NIKOPACK/Ti-trader](https://github.com/NIKOPACK/Ti-trader) instead of the 404 `NIKOPACK/Ti` URL.
- The release gate now requires evidence schemaVersion 2: an active Paper soak (directory identity, at least seven successful round-trips, a controlled fault and later recovery), an externally verified live-capabilities artifact, and an Ed25519 signature from `scripts/release-reviewers.json` over the canonical candidate and artifact hashes. Idle soaks, offline-contract capability rows and unsigned approvals stay blocked.
- Autonomous market-lab candle requests fetch one extra bar and keep closed candles, matching the interactive session bridge, so the 20-bar minimum is reachable during market hours. Futures vs spot source uses `isFuturesSymbol`.
- Subagent session listing skips incomplete or corrupt session directories instead of failing the whole owner scope. `create()` removes a directory if metadata never becomes durable.
- Reclaiming a session whose in-flight run record is unreadable marks the session interrupted instead of leaving it stuck `running`.
- Non-review continuations cannot complete using only inherited evidence citations; at least one observation from the current run is required.
- Research children use a supervised read-only bridge to the parent's actual market and enabled services, preserving futures symbols, source metadata and batch candle cutoffs instead of silently reverting Ti research to public spot data.
- Reclaiming a research session kills an orphaned detached child instead of leaving the session busy; worker stop waits past the child SIGKILL watchdog; busy errors and session listings expose `childPid`.
- Plan-linked `intentId` reuse fingerprints stable order identity only. A moved ticker snapshot no longer throws before the engine can reuse a released identity or block an unknown one.
- Cancelling a live protective stop without account hard risk is refused (engine-enforced), matching the account-risk cancellation guard; `cancel_order` and `cancel_order_list` document the refusal.
- A group/world-readable `~/.ti-trader/agent/keys.json`, Zhihu access-secret file or freqtrade auth file is tightened to mode 600 on read, mirroring the enforced permissions on managed writes.
- Trading tool presentation distinguishes preflight rejection or uncertainty from tool completion, and open or partially filled orders from completed fills, without using the generic success background for business failures.
- Settings allowed-symbol edits drop empty tokens such as a trailing comma, instead of failing validation.
- Live futures prompts no longer treat reduce-only conditionals as unconditionally available; the model must check `get_trading_capabilities`.
- Market-lab replay percentage fields now return percentages (`10` for 10%) instead of fractions. Additive returns are explicitly distinguished from compounded or account returns.
- Market-lab rejects invalid candle limits, unclosed data and stale session-runtime results, and propagates cancellation and request timeouts through tools and slash commands.
- Trigger crossings reject stale or unordered baselines, unknown conditions preserve edge arming, and unsupported or ambiguous facts no longer silently select a position. Bounded history survives restarts and faster concurrent pollers.
- Concurrent `ti` sessions entering credentials for different exchanges no longer overwrite each other's `keys.json` entries: `/exchange-login` collects all input first and merges only the target exchange's entry under the keys-file lock.
- Switching a venue live validates only that venue's credential entry; a malformed entry for another exchange no longer blocks the switch.
- Order and trigger monitors log and notify coarse failure classifications (timeout, rate-limited, authentication-failed, disconnected) instead of raw transport error messages, matching the autonomous runtime's sanitization discipline.

## [0.2.2] - 2026-09-11

### Changed

- Refined the interactive Ti header with a drawn wordmark, bilingual shortcuts, and a compact layout for narrow terminals. Existing shortcut expansion and quiet startup settings are preserved.
- Trading venue status now separates mode and pause badges from exchange details, aligns the market-data source on wide terminals, and wraps on narrow terminals without hiding the pause state.

## [0.2.1] - 2026-09-10

### Added

- Live order approval is now an explicit mode (`confirm` or `unattended`). Paper defaults to `unattended`; live defaults to `confirm`. Switching mode (including `ti --mode live` against a paper config) applies that mode's default. Switching live to `unattended` requires interactive confirmation via Settings or `/approval unattended`; unknown-submission recovery is unchanged.
- Optional `subagent` extension (`TI_SUBAGENT=1` or `--extension`). Isolated children (`researcher`, `scanner`, `reviewer`) may `propose_order`; that does not submit. The parent must `check_order` then `buy`/`sell`. Paper/unattended: parent execution is the approval. Live/confirm: the operator confirmation box still appears.
- Optional `freqtrade` extension (`TI_FREQTRADE_URL` or `--extension`). Talks to a loopback `freqtrade webserver` for compact backtests and strategy signals. Live sidecars and `forceenter`/`start`/`stop` are rejected. Each research call re-reads `/show_config`; cancel/timeout abort the sidecar job; loopback requests bypass `HTTP_PROXY`. Execution stays on native `buy`/`sell`.

### Changed

- `/exchange-login` follows the live venue credential policy: Binance does not prompt for a passphrase; OKX requires one. Live runtime construction rejects an OKX key set that is missing a passphrase.
- Market-lab indicators, scans and replays use this session's `get_klines` and stamp `source`. Without the session bridge they still use Binance public spot klines and mark `kind: "binance-public-klines"`.
- The trading prompt is rebuilt each turn from the session's active tools. Research tools are named only when loaded; futures account tools are documented on futures sessions; `screen_markets` uses this session's market family rather than spot-only candidates.
- Interactive startup no longer prints the generic “ask Ti how to use Ti” onboarding line.
- The operating loop is a scannable sequence with skip rules. Tool notes are grouped under the same step names.
- Pinned `undici` `8.9.0` on `ti-trader` so the bundled freqtrade extension can resolve its loopback HTTP agent after publish.
- Pinned `@nikopack/ti-trading-engine` `0.3.3`.

### Fixed

- The Analyze operating loop now documents Freqtrade sidecar tools when market-lab tools are not in the session.

## [0.2.0] - 2026-09-08

### Breaking Changes

- Duplicate market-lab tools `analyze_market_structure` and `generate_trade_signal` are removed. Use `evaluate_strategy`.
- The `zhihu_search` alias is removed. Use `zhihu_global_search`.
- Default `ti` sessions autoload only market-lab and market-chart. `web-search`, `zhihu-research`, and `market-research` load when `TAVILY_API_KEY`, a Zhihu secret, or `TI_MARKET_RESEARCH` is set, or via `--extension`.

### Added

- Show the active exchange and market-data source on one line above the editor. Slash command tables keep the same venue stamp so a scrolled transcript still names the source. Paper labels public exchange market data separately from the simulated ledger.

### Changed

- Slash command tables, empty states, confirms, and notifications now use the same zh-CN/en-US catalog as Settings.
- The trading prompt treats market-lab as Binance public spot analysis, not a fillable signal for another venue. `show_market_view` is TUI-only and does not invent levels. `web_search`, `zhihu_global_search`, and `market_research` may be absent.
- Pinned `@nikopack/ti-trading-engine` `0.3.2`.

## [0.1.11] - 2026-09-08

### Changed

- Pinned `@nikopack/ti-trading-engine` `0.3.1`.

### Fixed

- Independent installs no longer import `createProjectTrustContext` or `resolveProjectTrusted` from `@earendil-works/pi-coding-agent@0.84.3`. Those names exist in the workspace fork but are not on the published package export surface, so `ti --version` failed with `SyntaxError` after `npm install ti-trader`.

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

[Unreleased]: https://github.com/NIKOPACK/Ti-trader/compare/v0.1.11...HEAD
[0.1.11]: https://github.com/NIKOPACK/Ti-trader/compare/v0.1.10...v0.1.11
[0.1.10]: https://github.com/NIKOPACK/Ti-trader/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/NIKOPACK/Ti-trader/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/NIKOPACK/Ti-trader/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/NIKOPACK/Ti-trader/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/NIKOPACK/Ti-trader/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/NIKOPACK/Ti-trader/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/NIKOPACK/Ti-trader/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/NIKOPACK/Ti-trader/compare/v0.1.2...v0.1.3
[0.1.1]: https://github.com/NIKOPACK/Ti-trader/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/NIKOPACK/Ti-trader/releases/tag/v0.1.0
