# Ti

Ti 是一个基于 [Pi agent harness](https://github.com/earendil-works/pi) 的 AI 加密货币交易命令行工具。它结合 Pi 的模型运行时和 [ccxt](https://github.com/ccxt/ccxt) 交易所连接能力，支持模拟盘和实盘交易。

> English documentation: [README.md](README.md)

## 安全提示

启用 live 模式后，Ti 可能通过交易所 API 提交真实订单，可能造成全部资金损失。Ti 不提供投资建议，也不保证盈利。请先使用 paper 模式，设置严格的单笔和每日风控上限，并为交易所 API key 关闭提现权限。网络超时或进程退出不会撤销已经提交的订单；使用前请确认订单和交易所账户状态。

## 安装

```bash
npm install -g ti-trader
ti                         # 交互模式，默认使用模拟盘
ti -p "分析 BTC 1h 走势"    # 一次性无头模式
```

首次运行使用 `/login` 配置模型供应商。模型认证信息、交易所密钥和会话状态保存在 `~/.ti/agent/`，与 Pi coding agent 的 `~/.pi` 完全隔离。

## 功能

- **模拟盘**：无需 API key，模拟成交、持仓、手续费和盈亏
- **实盘交易**：支持 ccxt 支持的交易所；API key 保存在本地，文件权限为 600
- **原生交易工具**：向 LLM 提供行情、账户、下单和撤单工具
- **风控限制**：单笔名义金额、每日名义金额、交易币种白名单和实盘订单确认
- **条件单**：止损、止盈、移动止损和 OCO 括号单
- **后台监控**：监控挂单成交、未保护仓位和浮亏，并可唤醒 agent
- **Binance USDⓈ-M 合约**：支持杠杆、保证金模式、持仓模式和 reduceOnly 等参数
- **编码工具禁用**：Ti 不提供 Pi coding agent 的文件读写、Shell 和代码编辑工具

## 常用命令

- `/balance`：查看余额和计价
- `/positions`：查看持仓和未实现盈亏
- `/orders [symbol]`：查看当前挂单
- `/trades [symbol]`：查看历史成交
- `/markets [limit]`：查看高交易量市场
- `/mode [paper|live]`：切换交易模式
- `/exchange [id]`：切换交易所
- `/risk`：查看风控限制和当日用量
- `/keys <exchange>`：交互配置交易所 API key
- `/monitor [on|off]`：开关后台监控

## 配置

配置文件位于 `~/.ti/agent/trading.json`：

```json
{
  "mode": "paper",
  "exchange": "okx",
  "marketType": "spot",
  "quoteCurrency": "USDT",
  "confirmLiveOrders": true,
  "risk": {
    "maxOrderNotional": 500,
    "maxDailyNotional": 2000,
    "allowedSymbols": []
  }
}
```

实盘 API key 可通过 `/keys okx` 交互录入，也可以编辑 `~/.ti/agent/keys.json`。只授予必要的交易权限，禁止提现权限；不要将 key、token 或账户敏感信息提交到仓库、issue、PR 或日志。

## 构建和验证

在仓库根目录执行：

```bash
npm install --ignore-scripts
cd packages/coding-agent && npm run build:unbundled && cd ../..
npm run build:trading
npm run check
./test.sh
```

`npm run smoke` 会执行依赖检查和模拟盘 E2E 测试，其中行情测试需要网络连接，但不会提交真实订单。

## 参与贡献

提交 PR 前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。涉及交易、风控、凭证或实盘行为的改动，必须保留或加强 paper-first 默认值、风险限制和实盘订单确认流程。安全漏洞请通过 [GitHub Security Advisories](https://github.com/NIKOPACK/Ti/security/advisories/new) 私下报告，不要公开提交 issue。

## 许可证

Ti 使用 MIT License。项目基于 [Pi](https://github.com/earendil-works/pi) 开发，Pi 由 Mario Zechner 按 MIT License 发布；详情见 [LICENSE](LICENSE)。
