# Ti

[简体中文文档](README.zh-CN.md)

An AI trading agent CLI built on the [Pi agent harness](https://github.com/earendil-works/pi). It pairs the pi coding-agent runtime with native exchange connectivity (via [ccxt](https://github.com/ccxt/ccxt)) for paper and live crypto trading.

## Safety notice

Ti can place real cryptocurrency orders when live mode is enabled. Live trading can lose all deposited funds; Ti is not investment advice and does not guarantee profits. Start with paper mode, use strict risk limits, and create exchange API keys without withdrawal permission. Review every live order and your local `~/.ti/agent/` permissions before use.

## Install

```bash
npm install -g ti-trader
ti                    # interactive mode (paper trading by default)
ti -p "分析 BTC 1h 走势"  # one-shot headless mode
```

On first run, use `/login` to configure a model provider. Model auth, exchange keys, and session state are stored under `~/.ti/agent/`, fully isolated from the pi coding agent's `~/.pi`.

## Features

- **Paper trading** with simulated fills, positions, and PnL — no API keys required
- **Live trading** on any ccxt-supported exchange (API keys stored locally, mode 600)
- **Native trading tools** exposed to the LLM (market data, order placement, portfolio queries)
- **Risk limits**: per-order and per-day notional caps, symbol allowlists, live-order confirmation
- **Take-profit / stop-loss orders**: stop, take-profit and trailing stop order types in both paper and live mode
- **Slash commands** rendered as transcript entries:
  - `/balance` — account balances with quote-currency valuation
  - `/positions` — holdings with average entry and unrealized PnL (paper mode)
  - `/orders [symbol]` — open orders
  - `/trades [symbol]` — order history
  - `/markets [limit]` — top markets by 24h volume
  - `/mode [paper|live]` — switch trading mode
  - `/exchange [id]` — switch the active exchange (ccxt id)
  - `/risk` — show risk limits and today's usage
  - `/keys <exchange>` — set exchange API keys interactively

Configuration and state live under `~/.ti/agent/` (`trading.json`, `keys.json`, session state).

## Packages

| Package | Description |
|---------|-------------|
| **[ti-trader](packages/trading-agent)** | Trading agent CLI (`ti`): buy/sell tools, trading slash commands, paper & live modes |
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
npm run build                 # Build all packages
npm run build:trading         # Build only the trading agent
npm run check                 # Lint, format, and type check
./test.sh                     # Run tests (skips LLM-dependent tests without API keys)
```

## Supply-chain hardening

npm dependency changes are treated as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `TI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps and native TypeScript import compatibility.

## License

MIT. Ti is derived from [pi](https://github.com/earendil-works/pi) (MIT, copyright Mario Zechner); see [LICENSE](LICENSE).
