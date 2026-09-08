# Ti

[English](README.md)

[![npm](https://img.shields.io/npm/v/ti-trader.svg)](https://www.npmjs.com/package/ti-trader)
[![Node](https://img.shields.io/node/v/ti-trader.svg)](https://www.npmjs.com/package/ti-trader)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

AI 交易 agent CLI。默认 Paper 模拟盘。实盘下单需要确认。

基于 [Pi agent harness](https://github.com/earendil-works/pi)，通过 [ccxt](https://github.com/ccxt/ccxt) 连接交易所。Pi 的编码工具已全部移除。

> 启用 live 后可能造成全部资金损失。Ti 不提供投资建议。请先用 paper，收紧风控，API key **不要**开提现。超时或进程退出不会撤销已经到达交易所的订单。

## 安装

需要 Node.js `>= 22.19.0`。

```bash
npm install -g ti-trader
ti --version    # ti 0.1.11
ti              # 交互模式，默认模拟盘
ti -p "分析 BTC 1h 走势"
```

若出现 `EACCES`，不要用 `sudo`。把 npm 全局目录改到用户目录：

```bash
mkdir -p ~/.npm-global
npm config set prefix "$HOME/.npm-global"
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
npm install -g ti-trader
```

## 第一次运行

| 步骤 | 操作 |
| --- | --- |
| 1 | `/login` 配置模型供应商 |
| 2 | 留在 paper，不必配交易所 key |
| 3 | 要做实盘时再用 `/exchange-login` |
| 4 | `/settings` 切换语言、模式、市场、风控、模拟账户和监控 |

数据在 `~/.ti-trader/agent/`（`trading.json`、`keys.json`、会话），不读写 Pi 的 `~/.pi`。长跑或验收请设置独立的 `TI_DATA_DIR`。

## 能力

- **模拟盘** — 本地账本、公开行情、手续费和盈亏，无需 API key
- **实盘** — ccxt 适配器；密钥本地保存，权限 `600`。Paper 与 Binance 有离线契约覆盖，其他交易所仍属实验性
- **风控** — 单笔和每日名义金额、币种白名单、实盘确认、持久化开仓暂停。未知提交不会自动重发
- **恢复** — 启动时有界关联查询；`/recovery`、`/audit`、`/health`
- **订单** — Paper 现货和支持的实盘市场提供市价、限价、止损、止盈、移动止损和 OCO；Paper 合约目前仅市价
- **分析** — 内置 market-lab 指标和筛选，不会下单

## 命令

| 命令 | 作用 |
| --- | --- |
| `/settings` | 语言、模式、交易所、市场、密钥、风控、模拟账户、监控 |
| `/balance` `/positions` `/orders` `/trades` `/markets` | 账户与市场视图 |
| `/mode` `/exchange` `/market` | 切换运行时；live 需要密钥和确认 |
| `/risk pause` `/risk resume` | 暂停或恢复新增敞口。恢复必须交互确认 |
| `/recovery` `/audit` `/health` | 执行记录、脱敏审计、本地开仓健康 |
| `/trigger` | 持久化实验性条件。live 触发器只通知 |
| `/exchange-login <id>` | 写入交易所 API key |
| `/login` | 模型供应商（Pi） |
| `/tui-settings` | Agent 界面设置 |

## 状态

运维：[手册](docs/trading-operations.md)。发布证据：[门槛](docs/trading-release-evidence.md)。计划：[里程碑](docs/product-readiness-plan.md)。

已发布 CLI 不等于生产验收完成。七天 Paper 长跑、独立候选安装和授权实盘试点仍需各自的证据。

## 包

已公开发布：

| 包 | 作用 |
| --- | --- |
| **[ti-trader](https://www.npmjs.com/package/ti-trader)** `0.1.11` | CLI（`ti`） |
| **[@nikopack/ti-trading-engine](https://www.npmjs.com/package/@nikopack/ti-trading-engine)** `0.3.1` | 适配器、规划、保护 |
| **[@nikopack/ti-trading-risk](https://www.npmjs.com/package/@nikopack/ti-trading-risk)** `0.2.0` | 名义金额限制与持久化占用 |
| **[@nikopack/ti-triggers](https://www.npmjs.com/package/@nikopack/ti-triggers)** `0.1.0` | 确定性条件求值 |

上游 Pi 仍是私有 workspace 依赖（`@earendil-works/pi-coding-agent` 等），不要从本仓库发布。

## 开发

提交 PR 前阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。交易相关改动必须保留 paper-first、风控限制和实盘确认。

```bash
npm install --ignore-scripts
npm --prefix packages/coding-agent run build:unbundled
npm run build:trading
npm run check
./test.sh
```

`npm run build:trading` 依次构建 tui、triggers、risk、engine、agent。隔离回归：`node scripts/trading-readiness.mjs --report /tmp/ti-offline.json`。可发布包的直接依赖保持精确版本。

## 许可证

MIT。基于 [pi](https://github.com/earendil-works/pi)（MIT，版权 Mario Zechner）。见 [LICENSE](LICENSE)。
