# Ti

[English](README.md)

[![npm](https://img.shields.io/npm/v/ti-trader.svg)](https://www.npmjs.com/package/ti-trader)
[![Node](https://img.shields.io/node/v/ti-trader.svg)](https://www.npmjs.com/package/ti-trader)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Ti** 是跑在终端里的加密货币 AI 交易助手。用自然语言说话：它读行情、核对仓位和风控，默认在模拟盘成交；只有你打开实盘，并且确认之后，才会把订单送到交易所。

它是交易 agent，不是「coding agent 外挂了一个交易所」。[Pi](https://github.com/earendil-works/pi) 的 `read` / `bash` / `edit` / `write` 已全部去掉。交易所密钥只留在本机（`~/.ti-trader`，权限 `600`）。模型拿着 key 也不能翻你的磁盘、也不能跑 shell。

> 启用 live 后可能亏光账户里的钱。Ti 不是投资建议，也不保证盈利。先用 paper，把风控上限收紧，API key **不要**开提现。超时或进程退出，不会撤销已经到达交易所的订单。

## 给谁用

会交易（或正在用模拟盘学），能用 CLI，希望 LLM 帮你看盘、试单、执行，但**不愿意**把文件系统或静默实盘通道交给模型。

不是信号源、跟单机器人，也不是「设好就不管」的无人值守服务。

## 实际拿到的东西

**默认就是模拟盘。** 本地账本、公开行情、手续费和盈亏。不需要交易所 API key。

**实盘是一扇你自己开的门。** Binance 现货和 USDⓈ-M 的适配覆盖最完整；OKX、Bybit 仍标 experimental。实盘默认逐单确认。把审批改成 `unattended` 必须显式确认。

**风控不靠提示词。** 单笔/每日名义上限、币种白名单、持久化「暂停新开仓」由引擎强制。未知提交不会自动重发。重启只对账，不会悄悄恢复开仓权限。

**分析不会成交。** 内置 market-lab 指标、筛选和图表走本会话 K 线。可选 Freqtrade 侧车连本机 webserver 做回测。这些路径都不下单。

一次典型对话：

```text
你:  分析 BTC 1h。如果结构允许，用 100 USDT 在模拟盘买入。
Ti:  读 K 线 / 指标 / 余额
     check_order  → 数量、名义金额、剩余额度
     paper 成交   → 本地账本，公开行情
```

实盘时最后一步是确认框，然后才是 `buy` / `sell`。`check_order` 不预留额度，也不提交。

## 安装

需要 Node.js `>= 22.19.0`。

```bash
npm install -g ti-trader
ti --version
ti                          # 交互 TUI，默认模拟盘
ti -p "分析 BTC 1h 走势"     # 一次性，无界面
```

不要 `sudo npm install -g`。若出现 `EACCES`：

```bash
mkdir -p ~/.npm-global
npm config set prefix "$HOME/.npm-global"
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
npm install -g ti-trader
```

升级用 `npm install -g ti-trader@latest`。

## 第一次运行

| 步骤 | 做什么 |
| --- | --- |
| 1 | `/login` — 配置模型供应商（与 Pi 同一套 provider） |
| 2 | 留在 paper，不必配交易所 key |
| 3 | 中文或英文都行。例如：`看 ETH 4h，给观察计划，先不要下单` |
| 4 | `/settings` — 语言、风控上限、市场、模拟资金、监控 |
| 5 | 真要做实盘再用 `/exchange-login` |

数据在 `~/.ti-trader/agent/`（`trading.json`、`keys.json`、会话）。不读写 Pi 的 `~/.pi`。长跑或隔离验收请设独立的 `TI_DATA_DIR`。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `/settings` | 语言、模式、交易所、市场、密钥、风控、模拟账户、监控 |
| `/balance` `/positions` `/orders` `/trades` `/markets` | 账户与市场 |
| `/mode` `/exchange` `/market` `/approval` | 切换运行时。live 需要密钥。`unattended` 需要确认 |
| `/risk pause` `/risk resume` | 暂停或恢复**新增**敞口。恢复必须交互确认 |
| `/recovery` `/audit` `/health` | 未决执行、脱敏审计、本地开仓健康 |
| `/exchange-login <id>` | 写入交易所 API key |
| `/login` | 模型供应商 |
| `/tui-settings` | Agent 界面 |

`/trigger` 是实验性功能。live 触发器只通知，不会拉起交易回合。

## 先说清楚的边界

- Paper 合约目前只有市价单。Paper 现货支持限价、止损、止盈、移动止损和 OCO。
- `get_trading_capabilities` 会返回 `supported`、`unsupported` 或 `unknown`。`unknown` 不能当成「大概可以」。
- 缺 bid/ask、资金费率或未平仓量时返回 `null` 加 `warnings`，不会伪装成 `0`。
- 可选研究扩展（`web-search`、`zhihu-research`、`market-research`、`subagent`、`freqtrade`）只在对应环境变量或 `--extension` 时加载，都不能下单。
- 已发布 CLI 不等于生产验收完成。七天 Paper 长跑和任何实盘试点都要单独留证据。

运维手册：[docs/trading-operations.md](docs/trading-operations.md)。设计：[packages/trading-agent/DESIGN.md](packages/trading-agent/DESIGN.md)。引擎契约：[packages/trading-engine/README.md](packages/trading-engine/README.md)。

## 包

公开发布：

| 包 | 作用 |
| --- | --- |
| **[ti-trader](https://www.npmjs.com/package/ti-trader)** | CLI（`ti`） |
| **[@nikopack/ti-trading-engine](https://www.npmjs.com/package/@nikopack/ti-trading-engine)** | 适配器、规划、保护 |
| **[@nikopack/ti-trading-risk](https://www.npmjs.com/package/@nikopack/ti-trading-risk)** | 名义上限与持久化占用 |
| **[@nikopack/ti-triggers](https://www.npmjs.com/package/@nikopack/ti-triggers)** | 确定性条件求值 |

上游 Pi 仍是私有 workspace 依赖。不要从本仓库发布 `@earendil-works/*`。

## 开发

提交前读 [CONTRIBUTING.md](CONTRIBUTING.md)。削弱 paper-first、风控层或实盘确认的改动，需要很强的理由。

```bash
npm install --ignore-scripts
npm --prefix packages/coding-agent run build:unbundled
npm run build:trading
npm run check
./test.sh
```

## 许可证

MIT。基于 [pi](https://github.com/earendil-works/pi)（MIT，版权 Mario Zechner）。见 [LICENSE](LICENSE)。
