# Ti

[简体中文](README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/ti-trader.svg)](https://www.npmjs.com/package/ti-trader)
[![Node](https://img.shields.io/node/v/ti-trader.svg)](https://www.npmjs.com/package/ti-trader)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Ti** is an AI trading assistant that runs in your terminal. You talk to it in natural language. It reads the market, checks size and risk, paper-trades against public prices, and — only if you open live — waits for you before it sends an order.

It is a trading agent, not a coding agent with an exchange plugin. The `read` / `bash` / `edit` / `write` tools from [Pi](https://github.com/earendil-works/pi) are gone. Exchange keys stay on your machine (`~/.ti-trader`, mode `600`). The model cannot browse your disk or run a shell while it holds those keys.

> Live mode can lose all deposited funds. Ti is not investment advice and does not promise profit. Use paper first, keep risk caps tight, and create API keys **without** withdrawal permission. A timeout or process exit does not cancel an order that already reached the exchange.

## Who it is for

People who already trade (or are learning on paper), can use a CLI, and want an LLM in the loop **without** giving it a filesystem or a silent path to live orders.

It is not a signal feed, a copy-trading bot, or an unattended “set and forget” service.

## What you actually get

**Paper is the product default.** A local ledger fills against public market data, with fees and PnL. No exchange API key.

**Live is a door you open.** Binance spot and USDⓈ-M have the strongest adapter coverage. OKX and Bybit are experimental. Live defaults to per-order confirmation. Switching approval to `unattended` is an explicit, confirmed choice.

**Risk is not a prompt.** Per-order and daily notional caps, a symbol allowlist, and a durable “pause new exposure” switch are enforced by the engine. Unknown submissions are never resent. Restarts reconcile; they do not silently restore entry.

**Analysis does not fill.** Bundled market-lab indicators, screens and charts use this session's klines. An optional Freqtrade sidecar talks to a loopback webserver for backtests. None of these place orders.

A typical turn:

```text
You:  分析 BTC 1h。如果结构允许，用 100 USDT 在模拟盘买入。
Ti:   reads klines / indicators / balance
      check_order  → size, notional, risk remaining
      paper fill   → local ledger, real public price
```

On live, that last step is a confirmation box, then `buy` / `sell`. `check_order` never reserves quota and never submits.

## Install

Requires Node.js `>= 22.19.0`.

```bash
npm install -g ti-trader
ti --version
ti                          # interactive TUI, paper
ti -p "分析 BTC 1h 走势"     # one-shot, no TUI
```

Do not `sudo npm install -g`. If npm reports `EACCES`:

```bash
mkdir -p ~/.npm-global
npm config set prefix "$HOME/.npm-global"
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
npm install -g ti-trader
```

Upgrade with `npm install -g ti-trader@latest`.

## First session

| Step | What to do |
| --- | --- |
| 1 | `/login` — model provider (same family of providers as Pi) |
| 2 | Stay on paper. No exchange keys |
| 3 | Ask in Chinese or English. Example: `看 ETH 4h，给观察计划，先不要下单` |
| 4 | `/settings` — language, risk caps, market, paper balance, monitor |
| 5 | `/exchange-login` only when you intend to trade live |

State is `~/.ti-trader/agent/` (`trading.json`, `keys.json`, sessions). Ti does not read or write Pi's `~/.pi`. For a soak or an isolated check, set `TI_DATA_DIR` to a dedicated directory.

## Commands you will actually use

| Command | Purpose |
| --- | --- |
| `/settings` | Language, mode, exchange, market, keys, risk, paper, monitor |
| `/balance` `/positions` `/orders` `/trades` `/markets` | Account and market views |
| `/mode` `/exchange` `/market` `/approval` | Runtime switches. Live needs keys. `unattended` needs confirmation |
| `/risk pause` `/risk resume` | Block or restore **new** exposure. Resume is interactive |
| `/recovery` `/audit` `/health` | Unresolved executions, redacted history, local admission health |
| `/exchange-login <id>` | Store exchange API keys |
| `/login` | Model provider |
| `/tui-settings` | Agent TUI chrome |

`/trigger` is experimental. Live triggers notify only; they do not wake a trading turn.

## Honest limits

- Paper futures is market-only. Spot paper supports limit, stop, take-profit, trailing and OCO.
- `get_trading_capabilities` returns `supported`, `unsupported` or `unknown`. `unknown` is not “probably fine”.
- Missing bid/ask, funding, or open interest comes back as `null` plus `warnings`, never as `0`.
- Optional research extensions (`web-search`, `zhihu-research`, `market-research`, `subagent`, `freqtrade`) load only when their env is set or you pass `--extension`. They cannot submit orders.
- A published CLI is not a production-acceptance claim. A seven-day Paper soak and any live pilot still need their own evidence.

Operator runbook: [docs/trading-operations.md](docs/trading-operations.md). Design: [packages/trading-agent/DESIGN.md](packages/trading-agent/DESIGN.md). Engine contract: [packages/trading-engine/README.md](packages/trading-engine/README.md).

## Packages

Public npm:

| Package | Role |
| --- | --- |
| **[ti-trader](https://www.npmjs.com/package/ti-trader)** | CLI (`ti`) |
| **[@nikopack/ti-trading-engine](https://www.npmjs.com/package/@nikopack/ti-trading-engine)** | Adapters, planning, protection |
| **[@nikopack/ti-trading-risk](https://www.npmjs.com/package/@nikopack/ti-trading-risk)** | Notional caps and durable reservations |
| **[@nikopack/ti-triggers](https://www.npmjs.com/package/@nikopack/ti-triggers)** | Deterministic trigger evaluation |

Upstream Pi stays a private workspace dependency. Do not publish `@earendil-works/*` from this repository.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). Changes that weaken paper-first defaults, the risk layer, or live-order confirmation need a strong reason.

```bash
npm install --ignore-scripts
npm --prefix packages/coding-agent run build:unbundled
npm run build:trading
npm run check
./test.sh
```

## License

MIT. Derived from [pi](https://github.com/earendil-works/pi) (MIT, copyright Mario Zechner). See [LICENSE](LICENSE).
