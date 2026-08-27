# Ti — AI Trading Agent

基于 [pi](https://github.com/earendil-works/pi) agent harness 二开的加密货币 AI 自动交易 CLI（npm 包名 `ti-trader`，命令 `ti`）。
复用 pi 的 agent 运行时、多模型层（`pi-ai`）、TUI，**原生内置交易工具**，移除了全部编码工具。

## 安全提示

启用 live 模式后，Ti 可能通过交易所 API 提交真实订单，可能造成全部资金损失。Ti 不提供投资建议，也不保证盈利。请先使用 paper 模式，设置严格的风控上限，并为交易所 API key 关闭提现权限。网络超时或进程退出不会撤销已经提交的订单；使用前请确认订单和交易所账户状态。

## 安装

当前发布版本为 `0.1.2`，使用 npm 全局安装：

```bash
npm install -g ti-trader@0.1.2
ti --version
ti            # 交互模式（默认 paper 模拟盘）
ti -p "..."   # 一次性无头模式
```

`ti-trader` 通过 npm 的 `bin` 配置自动提供 `ti` 命令。npm 全局目录必须位于当前用户可写且已加入 `PATH`；不建议让安装脚本修改 shell 配置或使用 root 权限覆盖系统 npm。普通用户可以使用用户级 npm 目录：

```bash
mkdir -p ~/.npm-global
npm config set prefix "$HOME/.npm-global"
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
npm install -g ti-trader
```

如果 npm 全局目录已经正确配置，也可以直接使用 `npm install -g ti-trader`。若已安装旧版本，请执行 `npm install -g ti-trader@latest` 更新。若提示 `EACCES`，请先执行上面的用户级 npm 配置，不要对项目目录执行 `sudo npm install`。安装后用 `ti --version` 确认版本。

Ti 与 pi 使用完全独立的配置目录。Ti 首次启动会创建 `~/.ti-trader/agent/`，不会读取或修改 pi 的 `~/.pi/` 配置、认证或会话文件。模型使用 pi 内置的 `/login`；交易所 API 使用 Ti 的 `/exchange-login`。安装 pi 后再安装 Ti 不需要迁移或删除 pi 文件。

## 特性

- **原生买卖工具**：`buy` / `sell` 是 agent 的一等工具（不是扩展），支持市价/限价、base/quote 双向下单
- **交易向 slash 命令**：`/balance` `/positions` `/orders` `/trades` `/markets` `/mode` `/exchange` `/risk` `/login` `/paper` `/monitor`
- **编码功能已移除**：`read`/`bash`/`edit`/`write`/`grep`/`find`/`ls` 工具全部禁用（`noTools: "builtin"`）
- **模拟盘优先**：默认 paper 模式，用真实行情撮合的本地模拟账户（含手续费、均价成本、PnL）
- **实盘安全门**：live 模式需要 API key + 启动/切换确认 + 每笔订单交互确认（可关）
- **风控层**：单笔/总名义金额上限、币种白名单，运行时强制，重启不重置。paper 额度为累计制,仅 `/risk reset` 或 `/paper reset` 手动重置;live 额度按日自动恢复
- **止盈止损**：`stop`/`stop_market`（止损触发）、`take_profit`/`take_profit_market`（止盈触发）、`trailing_stop_market`（按百分比回撤的移动止损），paper 与 live 均支持
- **OCO 括号单**：`place_oco` 一次挂上止损+止盈，任一成交自动撤销另一腿
- **后台监控与仓位守护**：轮询挂单成交并唤醒 agent 跟进；持仓无止损保护或浮亏超阈值时告警并唤醒 agent 处理或汇报
- **Binance USDⓈ-M 合约**：Binance 专用 swap 模式，支持杠杆、逐仓/全仓、单向/双向持仓、reduceOnly、止损触发参数及资金费率查询
- **市场数据完整性**：`get_order_book`、`get_market_info`、`get_contract_stats` 分别读取订单簿、Binance `exchangeInfo` 市场规则、`premiumIndex`/资金费率及未平仓量；缺失数据返回 `null` 和 `warnings`，不会伪装为 0

## 构建

```bash
# 在 monorepo 根目录：先构建上游包（仅需一次）
npm install --ignore-scripts
cd packages/coding-agent && npm run build:unbundled && cd ../..
# 构建 trading-agent
npm run build:trading
```

> 注：根 `npm run build` 里 coding-agent 的 esbuild 打包步骤在本机环境有已知的
> `<runtime>` external 报错（上游问题，与二开无关）。`build:unbundled` 产物即本包所需。

## 运行

```bash
node packages/trading-agent/dist/cli.js            # 交互模式（paper）
node packages/trading-agent/dist/cli.js -p "分析 BTC 1h 走势并说明是否适合开多"   # 一次性模式
node packages/trading-agent/dist/cli.js --mode live --exchange okx
# Binance USDⓈ-M futures（使用 BTC/USDT:USDT 等 ccxt 合约 symbol）
node packages/trading-agent/dist/cli.js --mode live --exchange binance
```

首次运行用 `/login` 配置模型 Provider；使用 `/exchange-login` 配置交易所 API。交易所支持 Binance（币安）、OKX、Bybit。使用 `/language` 可在中文和 English 之间切换，设置保存于 `~/.ti-trader/agent/trading.json`。模型认证存于 `~/.ti-trader/agent/auth.json`，交易所 API key 存于 `~/.ti-trader/agent/keys.json`，与 pi coding agent 隔离。

## 配置

`~/.ti-trader/agent/trading.json`：

```json
{
	"mode": "paper",
	"exchange": "okx",
	"marketType": "spot",
	"leverage": 1,
	"marginType": "isolated",
	"positionMode": "one-way",
	"quoteCurrency": "USDT",
	"confirmLiveOrders": true,
	"risk": { "maxOrderNotional": 500, "maxDailyNotional": 2000, "allowedSymbols": [] },
	"paper": { "startQuote": 10000, "feeRate": 0.001 },
	"monitor": {
		"enabled": true,
		"intervalSec": 30,
		"wakeAgent": true,
		"guardPositions": true,
		"alertLossPct": 5,
		"alertCooldownSec": 900
	}
}
```

实盘 API key：`/exchange-login okx` 交互录入，或编辑 `~/.ti-trader/agent/keys.json`（权限 600）。API key 只应授予必要的交易权限，不要授予提现权限；不要将 key、token 或账户敏感信息提交到仓库或贴入 issue。

## 余额字段说明

余额页面使用更直观的字段名称：

- `Available` / `可用余额`：可以立即用于交易的余额
- `Locked` / `冻结余额`：被未成交订单占用、暂时不可用的余额
- `Valuation` / `估值`：按当前行情折算为报价币的资产价值

交易所原始接口中的 `free` 对应可用余额，`used` 对应冻结余额，`total = free + used`。

## 止盈止损与移动止损

买卖工具支持五种条件单类型（paper 与 live 均可用）：

- `stop` / `stop_market`：价格向不利方向触及 `stopPrice` 时触发（卖单跌到触发价 = 止损；买单涨到触发价 = 突破追入）。`stop` 触发后以 `price` 挂限价单，`stop_market` 触发即成交。
- `take_profit` / `take_profit_market`：价格向有利方向触及 `stopPrice` 时触发（卖单涨到触发价 = 止盈）。
- `trailing_stop_market`：`trailingPercent` 移动止损。卖单跟踪下单以来的最高价，回撤给定百分比即触发；买单跟踪最低价，反弹给定百分比触发。
- `place_oco`：OCO 括号单，一次同时挂止损（`stopLossPrice`）与止盈（`takeProfitPrice`），任一腿成交自动撤销另一腿；撤销任一腿等于撤销整组。入场成交后的首选保护方式。

下单时触发条件已满足会被直接拒绝（与交易所行为一致）。

Paper 模式的触发在每次账户读取时懒惰撮合：所有挂单（限价/触发/移动止损）都用 1m/15m/1h K 线回填两次读取之间的最高/最低价，不会漏掉读取间隙里的价格波动。实盘通过 ccxt 统一参数（`stopLossPrice`/`takeProfitPrice`/`trailingPercent`）下发，OKX 等交易所的算法单会自动合并进 `get_open_orders`，撤单自动带 `trigger`/`trailing` 参数重试；具体类型支持以交易所为准。

## 后台监控与仓位守护

交互模式下后台监控每 `monitor.intervalSec` 秒轮询一次（默认 30s，paper 模式下轮询同时驱动条件单撮合）：

- **成交通知**：挂单成交后注入 `[order monitor]` 消息；`wakeAgent: true` 时唤醒 agent 评估后续（如入场成交后补挂保护单）。
- **裸仓告警**：持仓没有任何止损类保护单（stop/移动止损/OCO 止损腿）且超过一个轮询周期宽限期时，注入 `[position guard]` 消息唤醒 agent——要么立刻设置保护，要么向用户说明为何不保护。
- **浮亏告警**：持仓未实现亏损达到 `alertLossPct`（默认 5%）时唤醒 agent 重新评估：砍仓、收紧止损或说明持有理由。同一仓位的告警受 `alertCooldownSec`（默认 900s）冷却限制，不会刷屏。

`/monitor` 查看状态，`/monitor on|off` 开关本次会话的监控。`/paper reset [金额]` 重置模拟账户。

## 合约说明

Binance USDⓈ-M 合约使用 ccxt unified symbol，例如 `BTC/USDT:USDT`，不是现货的 `BTC/USDT`。将 `marketType` 设为 `usdm-futures` 时，运行时强制要求 `exchange` 为 `binance`，并启用 ccxt `defaultType: swap`。

可用工具包括 `get_funding_rate`、`set_leverage`、`set_margin_mode`、`get_futures_positions`；买卖工具额外支持 `reduceOnly`、`positionSide`、`stopPrice`、`closePosition`。Paper futures 当前明确拒绝，不会模拟保证金或强平，避免把现货模拟误认为合约风控。

## 市场数据限制

`get_price` 的 `bid`/`ask` 缺失时返回 `null` 并标记 `dataQuality`，不能据此断言流动性为零。合约分析应先调用 `get_market_info`、`get_order_book` 和 `get_contract_stats`，核对合约类型、结算资产、标记价格、指数价格、价差和未平仓量。

这些接口遵循 Binance 官方 USDⓈ-M Futures REST API 的语义：`exchangeInfo`（交易规则）、`depth`（订单簿）、`premiumIndex`（标记价/指数价/资金费率）和 `openInterest`（未平仓量）。交易所市场接口不能证明发行方、白皮书、股票映射、储备或审计；不能仅根据如 `AMD` 的交易对名称推断底层资产真实性。字段不可用时，Ti 会明确报告限制并建议回避交易。

## 验证

```bash
npm run smoke   # headless 运行时检查 + 模拟盘 E2E（真实行情，模拟成交）
```

## 架构

```
src/
  cli.ts / main.ts      入口与 bootstrap（复用 pi 的 services/runtime/InteractiveMode）
  args.ts               CLI 参数（--mode/--exchange/--print）
  config.ts / state.ts  配置与状态持久化（~/.ti-trader/agent/）
  context.ts            交易运行时单例：exchange client、风控计数、模式切换
  exchange/
    types.ts            ExchangeClient 统一接口
    ccxt-client.ts      实盘客户端（ccxt，100+ 交易所）
    paper-client.ts     模拟盘引擎（真实行情 + 本地账户 + 懒撮合，含止盈止损/移动止损/OCO/K线回填）
  tools/index.ts        15 个原生交易工具（含 place_oco 与 Binance 合约工具）
  monitor.ts            后台成交监控 + 仓位守护（裸仓/浮亏告警，唤醒 agent）
  commands.ts           交易 slash 命令（inline extension factory）
  prompt.ts             交易系统提示词（整体替换编码提示词）
```
