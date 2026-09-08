# Ti

[简体中文](README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/ti-trader.svg)](https://www.npmjs.com/package/ti-trader)
[![Node](https://img.shields.io/node/v/ti-trader.svg)](https://www.npmjs.com/package/ti-trader)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

AI trading agent CLI. Paper mode is the default. Live orders require confirmation.

Ti is built on the [Pi agent harness](https://github.com/earendil-works/pi) and talks to exchanges through [ccxt](https://github.com/ccxt/ccxt). Coding tools from Pi are removed.

> Live mode can lose all deposited funds. Ti is not investment advice. Use paper first, keep risk limits tight, and create API keys **without** withdrawal permission. A timeout or process exit does not cancel an order that already reached the exchange.

## Install

Requires Node.js `>= 22.19.0`.

```bash
npm install -g ti-trader
ti --version    # ti 0.1.11
ti              # interactive, paper by default
ti -p "分析 BTC 1h 走势"
```

If npm reports `EACCES`, point the global prefix at your home directory instead of using `sudo`:

```bash
mkdir -p ~/.npm-global
npm config set prefix "$HOME/.npm-global"
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
npm install -g ti-trader
```

## First session

| Step | Action |
| --- | --- |
| 1 | `/login` to configure a model provider |
| 2 | Stay in paper. No exchange keys are required |
| 3 | `/exchange-login` only when you intend to trade live |
| 4 | `/settings` for language, mode, market, risk, paper and monitor |

State lives in `~/.ti-trader/agent/` (`trading.json`, `keys.json`, sessions). It does not read or write Pi's `~/.pi`. For a soak or isolated check, set `TI_DATA_DIR` to a dedicated directory.

## What it does

- **Paper** — local ledger, real public market data, fees and PnL. No API keys
- **Live** — ccxt adapters; keys stored locally at mode `600`. Paper and Binance have offline contract coverage; other venues are experimental
- **Risk** — per-order and daily notional caps, symbol allowlists, live confirmation, durable entry pause. Unknown submissions are never resent
- **Recovery** — bounded correlated lookup on restart; `/recovery`, `/audit`, `/health`
- **Orders** — market, limit, stop, take-profit, trailing and spot OCO in paper spot and supported live markets. Paper futures is market-only
- **Analysis** — bundled market-lab indicators and screens; they do not place orders

## Commands

| Command | Purpose |
| --- | --- |
| `/settings` | Language, mode, exchange, market, keys, risk, paper, monitor |
| `/balance` `/positions` `/orders` `/trades` `/markets` | Account and market views |
| `/mode` `/exchange` `/market` | Switch runtime; live needs keys and confirmation |
| `/risk pause` `/risk resume` | Block or restore new exposure. Resume is interactive |
| `/recovery` `/audit` `/health` | Executions, redacted history, local admission health |
| `/trigger` | Persistent experimental conditions. Live triggers notify only |
| `/exchange-login <id>` | Store exchange API keys |
| `/login` | Model provider (Pi) |
| `/tui-settings` | Agent TUI settings |

## Status

Operator procedures: [runbook](docs/trading-operations.md). Release evidence: [gate](docs/trading-release-evidence.md). Plan: [milestones](docs/product-readiness-plan.md).

A published CLI is not a production-acceptance claim. A seven-day Paper soak, clean candidate installation and a separately authorized live pilot still need their own evidence.

## Packages

Published (npm, public):

| Package | Role |
| --- | --- |
| **[ti-trader](https://www.npmjs.com/package/ti-trader)** `0.1.11` | CLI (`ti`) |
| **[@nikopack/ti-trading-engine](https://www.npmjs.com/package/@nikopack/ti-trading-engine)** `0.3.1` | Adapters, planning, protection |
| **[@nikopack/ti-trading-risk](https://www.npmjs.com/package/@nikopack/ti-trading-risk)** `0.2.0` | Notional limits and durable reservations |
| **[@nikopack/ti-triggers](https://www.npmjs.com/package/@nikopack/ti-triggers)** `0.1.0` | Deterministic trigger evaluation |

Upstream Pi remains a private workspace dependency (`@earendil-works/pi-coding-agent` and related packages). Do not publish those from this repository.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). Trading changes must keep paper-first defaults, risk limits and live-order confirmation.

```bash
npm install --ignore-scripts
npm --prefix packages/coding-agent run build:unbundled
npm run build:trading
npm run check
./test.sh
```

`npm run build:trading` builds tui, triggers, risk, engine, then the agent. Isolated regressions: `node scripts/trading-readiness.mjs --report /tmp/ti-offline.json`. Direct dependencies of publishable packages stay pinned to exact versions.

## License

MIT. Derived from [pi](https://github.com/earendil-works/pi) (MIT, copyright Mario Zechner). See [LICENSE](LICENSE).
