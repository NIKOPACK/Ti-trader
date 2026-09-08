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

首次运行使用 `/login` 配置模型供应商，并使用 `/exchange-login` 配置交易所凭证。模型认证信息、交易所密钥和会话状态保存在 `~/.ti-trader/agent/`，与 Pi coding agent 的 `~/.pi` 完全隔离。

## 功能

- **模拟盘**：无需 API key，模拟成交、持仓、手续费和盈亏
- **实盘交易**：通过 ccxt 适配器连接交易所；API key 保存在本地，文件权限为 600。Paper 和 Binance 路径具备离线契约覆盖，其他交易所仍属实验性，不代表已通过实盘认证
- **原生交易工具**：向 LLM 提供行情、账户、下单和撤单工具
- **风控限制**：单笔及累计/每日名义金额、交易币种白名单、实盘订单确认和持久化开仓暂停。执行记录关联的额度通过 `/recovery` 一起对账，`/risk reconcile` 仅用于历史独立占用；未知提交不会自动重发。
- **条件单**：Paper 现货和支持这些类型的实盘市场提供止损、止盈、移动止损和 OCO 括号单；Paper 合约目前仅支持市价单
- **后台监控**：监控挂单成交、未保护仓位和浮亏，并可唤醒 agent
- **Binance USDⓈ-M 合约**：支持杠杆、保证金模式、持仓模式和 reduceOnly 等参数
- **编码工具禁用**：Ti 不提供 Pi coding agent 的文件读写、Shell 和代码编辑工具

## 常用命令

- `/balance`：查看余额和计价
- `/positions`：查看持仓和未实现盈亏
- `/orders [symbol]`：查看当前挂单
- `/trades [symbol]`：查看历史成交
- `/markets [limit]`：查看高交易量市场
- `/mode [paper|live]`：切换交易模式（切 live 需要 API key 和交互确认；配置持久化后下次启动不再确认）
- `/exchange [id]`：切换交易所
- `/risk`：查看风控限制和用量；`/risk pause` 暂停新增敞口，`/risk resume` 必须人工确认
- `/recovery`：查看和对账持久化执行记录，不重发订单
- `/audit`：查看有界、脱敏的交易审计历史
- `/health`：查看开仓阻断、过期运行时和监控观测
- `/trigger`：持久化实验性条件监控（paper 可通知或唤醒；live 触发器只通知）
- `/exchange-login <exchange>`：交互配置交易所 API key
- `/monitor [on|off]`：开关后台监控

## 配置

配置文件位于 `~/.ti-trader/agent/trading.json`：

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

实盘 API key 可通过 `/exchange-login okx` 交互录入，也可以编辑 `~/.ti-trader/agent/keys.json`。只授予必要的交易权限，禁止提现权限；不要将 key、token 或账户敏感信息提交到仓库、issue、PR 或日志。

## 运行与恢复

开发状态见[六阶段计划](docs/product-readiness-plan.md)，故障处置见[运维手册](docs/trading-operations.md)，候选准入要求见[发布证据门槛](docs/trading-release-evidence.md)。账户维护后，旧进程不能继续提交旧计划；恢复和重试通知不会唤醒交易回合。`/health` 提示运行时过期时，应重启对应进程，不要重置额度来绕过。

当前工作区实现不等于生产验收完成。七天 Paper 稳定性运行、独立候选包安装和授权实盘试点仍需真实证据。

## 构建和验证

在仓库根目录执行：

```bash
npm install --ignore-scripts
cd packages/coding-agent && npm run build:unbundled && cd ../..
npm run build:trading  # 先构建 tui、triggers、trading-risk、trading-engine，再构建 trading-agent
npm run check                 # 只读检查 lint、格式和类型
npm run format:fix            # 显式应用 Biome 格式修复
./test.sh
```

`npm --prefix packages/trading-agent run smoke` 会执行运行时检查和模拟盘 E2E 测试，其中行情测试需要网络连接，但不会提交真实订单。构建顺序由 `npm run build:trading` 固定为先构建 tui 与 triggers、trading-risk，再构建 trading-engine，最后构建 trading-agent。`ti-trader` 会注册持久化实验性 `/trigger` 监控，不直接下单；live 下 `wake_agent` 只通知，不自动拉起交易回合。

产品候选应使用[发布证据门槛](docs/trading-release-evidence.md)中的隔离回归流程，它会隔离凭证、端点和数据目录。公开行情 smoke 与该流程分开执行；手动设置 `TI_DATA_DIR` 时应使用专用临时目录，不能指向真实账户数据。

## 参与贡献

提交 PR 前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。涉及交易、风控、凭证或实盘行为的改动，必须保留或加强 paper-first 默认值、风险限制和实盘订单确认流程。安全漏洞请通过 [GitHub Security Advisories](https://github.com/NIKOPACK/Ti/security/advisories/new) 私下报告，不要公开提交 issue。

## 许可证

Ti 使用 MIT License。项目基于 [Pi](https://github.com/earendil-works/pi) 开发，Pi 由 Mario Zechner 按 MIT License 发布；详情见 [LICENSE](LICENSE)。
