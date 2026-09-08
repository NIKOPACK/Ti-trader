# Ti

[简体中文文档](README.zh-CN.md)

An AI trading agent CLI built on the [Pi agent harness](https://github.com/earendil-works/pi). It pairs the pi coding-agent runtime with native exchange connectivity (via [ccxt](https://github.com/ccxt/ccxt)) for paper and live crypto trading.

## Safety notice

Ti can place real cryptocurrency orders when live mode is enabled. Live trading can lose all deposited funds; Ti is not investment advice and does not guarantee profits. Start with paper mode, use strict risk limits, and create exchange API keys without withdrawal permission. Review every live order and your local `~/.ti-trader/agent/` permissions before use.

## Install

```bash
npm install -g ti-trader
ti                    # interactive mode (paper trading by default)
ti -p "分析 BTC 1h 走势"  # one-shot headless mode
```

On first run, use `/login` to configure a model provider and `/exchange-login` to configure exchange credentials. Model auth, exchange keys, and session state are stored under `~/.ti-trader/agent/`, fully isolated from the pi coding agent's `~/.pi`.

## Features

- **Paper trading** with simulated fills, positions, and PnL — no API keys required
- **Live trading** through ccxt adapters (API keys stored locally, mode 600). Paper and Binance profiles have offline contract coverage; other venues remain experimental, not live-certified.
- **Native trading tools** exposed to the LLM (market data, order placement, portfolio queries)
- **Risk limits**: per-order and accumulated/daily notional caps, symbol allowlists, live-order confirmation and persistent entry pause. Journal-linked quota is reconciled through `/recovery`; `/risk reconcile` is reserved for legacy standalone claims. Unknown submissions are never automatically resent.
- **Take-profit / stop-loss orders**: stop, take-profit and trailing stop order types are available in Paper spot and supported live markets; Paper futures currently supports market orders only
- **Slash commands** rendered as transcript entries:
  - `/balance` — account balances with quote-currency valuation
  - `/positions` — holdings with average entry and unrealized PnL (paper mode)
  - `/orders [symbol]` — open orders
  - `/trades [symbol]` — order history
  - `/markets [limit]` — top markets by 24h volume
  - `/mode [paper|live]` — switch trading mode (live requires API keys and an interactive confirm; a persisted live config starts live on the next launch without confirming again)
  - `/exchange [id]` — switch the active exchange (ccxt id)
  - `/risk` — inspect limits and usage; `/risk pause` blocks new exposure and `/risk resume` requires confirmation
  - `/recovery` — inspect and reconcile durable executions without resubmission
  - `/audit` — bounded, redacted trading audit history
  - `/health` — local admission blocks, stale runtimes and monitor observations
  - `/trigger` — persistent experimental conditions (notify or wake in paper; live triggers notify only)
  - `/exchange-login <exchange>` — set exchange API keys interactively

Configuration and state live under `~/.ti-trader/agent/` (`trading.json`, `keys.json`, session state).

## Operational readiness

See the [six-stage plan](docs/product-readiness-plan.md), [operations runbook](docs/trading-operations.md) and [release evidence gate](docs/trading-release-evidence.md). Recovery preserves uncertainty and never substitutes a retry for missing evidence. Account maintenance invalidates stale processes; recovered or retried notifications do not wake trading.

The working-tree implementation is not a production acceptance claim. A seven-day Paper soak, clean candidate installation and separately authorized live pilot still require actual evidence.

## Packages

| Package | Description |
|---------|-------------|
| **[ti-trader](packages/trading-agent)** | Trading agent CLI (`ti`): tools, commands, persistence, and paper/live runtime integration |
| **[@earendil-works/ti-trading-engine](packages/trading-engine)** | Framework-independent engine: exchange adapters, planning, risk integration, and protection |
| **[@earendil-works/ti-trading-risk](packages/trading-risk)** | Trading risk-control ledger: notional limits and atomic, durable reservations |
| **[@earendil-works/ti-triggers](packages/triggers)** | Deterministic trigger evaluation; `ti-trader` persists experimental `/trigger` definitions and state. Live triggers notify only; a trigger message is not trading authorization |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Interactive agent CLI harness (upstream Pi) |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, …) |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@earendil-works/pi-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts and typed schemas |
| **[@earendil-works/pi-protocol](packages/protocol)** | Transport-neutral CBOR protocol for remote sessions |
| **[@earendil-works/pi-client](packages/client)** | Transport-neutral client for remote pi sessions |

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Trading behavior changes must preserve paper-first defaults, risk limits, and live-order confirmation.

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build                 # Build the Pi runtime and trading packages (use build:trading to include triggers)
npm run build:trading         # Build tui, triggers, trading-risk, trading-engine, then trading-agent
npm run check                 # Read-only lint, format, and type check
npm run format:fix            # Apply Biome formatting fixes explicitly
./test.sh                     # Run tests (skips LLM-dependent tests without API keys)
```

## Supply-chain hardening

npm dependency changes are treated as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Upstream Pi workspace packages may use ranges, while the publishable trading packages and the agent's `@earendil-works/ti-trading-engine` dependency use exact versions.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `TI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps and native TypeScript import compatibility.

## License

MIT. Ti is derived from [pi](https://github.com/earendil-works/pi) (MIT, copyright Mario Zechner); see [LICENSE](LICENSE).
