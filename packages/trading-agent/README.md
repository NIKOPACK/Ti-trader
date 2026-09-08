# Ti — AI Trading Agent

基于 [pi](https://github.com/earendil-works/pi) agent harness 二开的加密货币 AI 自动交易 CLI（npm 包名 `ti-trader`，命令 `ti`）。
复用 pi 的 agent 运行时、多模型层（`pi-ai`）、TUI，**原生内置交易工具**，移除了全部编码工具。

## 安全提示

启用 live 模式后，Ti 可能通过交易所 API 提交真实订单，可能造成全部资金损失。Ti 不提供投资建议，也不保证盈利。请先使用 paper 模式，设置严格的风控上限，并为交易所 API key 关闭提现权限。网络超时或进程退出不会撤销已经提交的订单；使用前请确认订单和交易所账户状态。

## 安装

已发布版本为 `ti-trader@0.1.11`。需要 Node.js `>= 22.19.0`。

```bash
npm install -g ti-trader
ti --version    # ti 0.1.11
ti              # 交互模式（默认 paper 模拟盘）
ti -p "..."     # 一次性无头模式
```

`ti` 由 npm `bin` 提供。全局目录必须可写且在 `PATH` 中。不要用 `sudo` 往系统 npm 里装。若出现 `EACCES`：

```bash
mkdir -p ~/.npm-global
npm config set prefix "$HOME/.npm-global"
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
npm install -g ti-trader
```

已安装旧版本时用 `npm install -g ti-trader@latest`。安装后用 `ti --version` 确认。

Ti 与 pi 使用完全独立的配置目录。Ti 首次启动会创建 `~/.ti-trader/agent/`，不会读取或修改 pi 的 `~/.pi/` 配置、认证或会话文件。模型使用 pi 内置的 `/login`；交易所 API 使用 Ti 的 `/exchange-login`。安装 pi 后再安装 Ti 不需要迁移或删除 pi 文件。

## 特性

- **原生买卖工具**：`buy` / `sell` 是 agent 的一等工具（不是扩展），支持市价/限价、base/quote 双向下单
- **交易前置检查**：`check_order` 只读解析下单意图，返回参考价、数量、名义金额、余额和风险额度；`get_trading_capabilities` 区分 `supported`、`unsupported`、`unknown`
- **组合与候选市场**：`get_portfolio_snapshot` 聚合余额、持仓、挂单和风险使用量；`get_top_markets` 提供有界的成交量候选排名（不是交易信号）
- **交易向 slash 命令**：`/settings` 打开交易设置（语言、模式、交易所、市场、密钥、风控、模拟账户、监控）；账户视图 `/balance` `/positions` `/orders` `/trades` `/markets`；配置命令无参数时同样打开设置。模型 Provider 仍使用 `/login`，Agent 界面使用 `/tui-settings`
- **编码功能已移除**：`read`/`bash`/`edit`/`write`/`grep`/`find`/`ls` 工具全部禁用（`noTools: "builtin"`）
- **模拟盘优先**：默认 paper 模式，用真实行情撮合的本地模拟账户（含手续费、均价成本、PnL）
- **实盘安全门**：live 模式需要 API key + 切换确认 + 每笔订单交互确认（可关）。切换到 live 后配置会持久化，下次启动不再确认。
- **风控层**：单笔/总名义金额上限、币种白名单，运行时强制，重启不重置。paper 额度为累计制，仅 `/risk reset` 或 `/paper reset` 手动重置；live 额度按日自动恢复。新执行记录及关联额度通过 `/recovery` 一起对账，历史独立占用仍使用 `/risk reconcile`，不要重试原订单。
- **持久化开仓暂停**：`/risk pause [原因]` 立即阻止当前模式的新增敞口；重启、重置额度不会解除。`/risk resume` 必须人工确认，未决额度占用会阻止恢复。经校验的减仓、保护卖单和撤单仍可执行。
- **止盈止损**：Paper 现货支持五种条件单类型：`stop`/`stop_market`（止损触发）、`take_profit`/`take_profit_market`（止盈触发）、`trailing_stop_market`（按百分比回撤的移动止损）；实盘是否支持取决于交易所，Paper 合约目前仅支持市价单
- **现货 OCO 括号单**：`place_oco` 一次挂上止损+止盈，任一成交自动撤销另一腿；合约不支持 OCO
- **后台监控与仓位守护**：轮询挂单成交、止损保护和浮亏变化；基线、冷却和通知标识持久化。实验性 `/trigger` 按账户保存条件与状态；live 触发器只通知，不自动拉起交易回合，恢复和重试通知也不会唤醒交易
- **执行恢复与运维**：启动及运行时替换会对未决执行做有界查询，不会自动重发订单；`/recovery` 查看和处置，`/audit` 查看脱敏审计记录，`/health` 查看本地阻断和观测健康
- **Binance USDⓈ-M 合约**：Binance 专用 swap 模式；Paper 支持独立合约账户、杠杆、逐仓/全仓、单向/双向持仓、reduceOnly、平仓、盈亏和保证金模拟，实盘支持交易所提供的合约订单参数及资金费率查询
- **市场数据完整性**：`get_order_book`、`get_market_info`、`get_contract_stats` 分别读取订单簿、Binance `exchangeInfo` 市场规则、`premiumIndex`/资金费率及未平仓量；live futures 可能提供 premium-index、资金费率和未平仓量字段；Paper futures 只返回其 ticker 模拟可提供的字段，不可用字段以 `warnings`/`null` 标记，不模拟资金费率或未平仓量观测；缺失数据返回 `null` 和 `warnings`，不会伪装为 0
- **默认只读量化**：会话自动加载 market-lab，提供 `calculate_indicators`、`analyze_market_structure`、`generate_trade_signal`、`evaluate_strategy`、`screen_markets`、`simulate_rule` 以及 `/indicators` `/signal` `/screen` `/replay`。数据来自 Binance 公共现货已收盘 K 线，不会下单

默认注入 agent 的交易工具共 25 个：行情 `get_price`、`get_order_book`、`get_market_info`、`get_contract_stats`、`get_klines`、`get_top_markets`；能力与账户 `get_trading_capabilities`、`get_balance`、`get_positions`、`get_portfolio_snapshot`、`get_open_orders`、`get_order_history`；订单查询与预检 `get_order_status`、`get_order_list_status`、`check_order`；执行 `buy`、`sell`、`place_oco`、`cancel_order`、`cancel_order_list`；风控与合约设置 `get_risk_status`、`get_funding_rate_history`、`set_leverage`、`set_margin_mode`、`set_multi_assets_mode`。另有 6 个只读量化工具由内置 market-lab 扩展注入：`calculate_indicators`、`analyze_market_structure`、`generate_trade_signal`、`evaluate_strategy`、`screen_markets`、`simulate_rule`。`get_funding_rate` 和 `get_futures_positions` 仍可由程序调用其 factory，但不再进入默认工具集，避免与统一的 `get_contract_stats`/`get_positions` 重复。

## 构建

```bash
# 在 monorepo 根目录：先构建上游包（仅需一次）
npm install --ignore-scripts
cd packages/coding-agent && npm run build:unbundled && cd ../..
# 先构建 trading-engine，再构建 trading-agent
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
# Paper 同时启用现货和 USDⓈ-M 合约
node packages/trading-agent/dist/cli.js --mode paper --exchange binance
```

首次运行用 `/login` 配置模型 Provider；使用 `/settings` 或 `/exchange-login` 配置交易所 API。交易所支持 Binance（币安）、OKX、Bybit。语言、模式和市场类型在 `/settings` 中切换，设置保存于 `~/.ti-trader/agent/trading.json`。模型认证存于 `~/.ti-trader/agent/auth.json`，交易所 API key 存于 `~/.ti-trader/agent/keys.json`，与 pi coding agent 隔离。

可选扩展位于仓库根目录 `extensions/`。使用 `--extension <path>` 加载用户扩展，可重复指定；使用 `--no-extensions` 禁用自动发现的用户扩展。公开互联网研究扩展位于 `extensions/web-search/`；知乎全网搜索扩展位于 `extensions/zhihu-research/`，需要通过 `ZHIHU_ACCESS_SECRET` 配置官方 OpenAPI 凭据。交易所 ccxt 连接、订单规划、风控和保护逻辑属于 `@nikopack/ti-trading-engine`；agent 通过 `marketData` 读取市场和账户数据，通过 `tradingEngine` 执行规划、风控与订单编排。

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

买卖工具支持五种条件单类型；这里的 Paper 触发与懒撮合特指 Paper 现货，live 的具体支持取决于交易所，Paper futures 当前仅支持市价单：

- `stop` / `stop_market`：价格向不利方向触及 `stopPrice` 时触发（卖单跌到触发价 = 止损；买单涨到触发价 = 突破追入）。`stop` 触发后以 `price` 挂限价单，`stop_market` 触发即成交。
- `take_profit` / `take_profit_market`：价格向有利方向触及 `stopPrice` 时触发（卖单涨到触发价 = 止盈）。
- `trailing_stop_market`：`trailingPercent` 移动止损。卖单跟踪下单以来的最高价，回撤给定百分比即触发；买单跟踪最低价，反弹给定百分比触发。
- `place_oco`：仅用于现货的 OCO 括号单，一次同时挂止损（`stopLossPrice`）与止盈（`takeProfitPrice`），任一腿成交自动撤销另一腿；撤销任一腿等于撤销整组。合约仓位应改用一个 `reduceOnly` 保护单。

下单时触发条件已满足会被直接拒绝（与交易所行为一致）。

`check_order` 是只读预检，不会预留额度或提交订单。`status` 可能为 `ok`、`ok_with_warnings`、`rejected` 或 `unknown`：`ok` 可直接执行，`ok_with_warnings` 只有在逐条审阅并接受 warnings 后才可执行，`rejected`/`unknown` 必须停止。live futures 的手续费和维护保证金数据目前由适配器明确标记为非阻断 warning，最终仍以交易所接受或拒绝为准；市场、余额或合约单位证据缺失仍是 blocking unknown。

Paper 现货模式的触发在每次账户读取时懒惰撮合：所有挂单（限价/触发/移动止损）都用 1m/15m/1h K 线回填两次读取之间的最高/最低价，不会漏掉读取间隙里的价格波动。Paper futures 当前仅支持市价单。实盘通过 ccxt 统一参数（`stopLossPrice`/`takeProfitPrice`/`trailingPercent`）下发，OKX 等交易所的算法单会自动合并进 `get_open_orders`，撤单自动带 `trigger`/`trailing` 参数重试；具体类型支持以交易所为准。

## 后台监控与仓位守护

交互模式下后台监控每 `monitor.intervalSec` 秒轮询一次（默认 30s，paper 模式下轮询同时驱动条件单撮合）：

- **成交通知**：挂单成交后注入 `[order monitor]` 消息；`wakeAgent: true` 时唤醒 agent 评估后续（如入场成交后补挂保护单）。
- **裸仓告警**：持仓没有任何止损类保护单（stop/移动止损/OCO 止损腿）且超过一个轮询周期宽限期时，注入 `[position guard]` 消息唤醒 agent——要么立刻设置保护，要么向用户说明为何不保护。
- **浮亏告警**：持仓未实现亏损达到 `alertLossPct`（默认 5%）时唤醒 agent 重新评估：砍仓、收紧止损或说明持有理由。同一仓位的告警受 `alertCooldownSec`（默认 900s）冷却限制，不会刷屏。

`/monitor` 查看状态，`/monitor on|off` 开关本次会话的监控。`/paper reset [金额]` 重置模拟账户。

## 暂停新增敞口与恢复

遇到异常订单、账户数据不一致或需要人工排查时，在 Ti 交互终端执行：

```text
/risk pause 核对交易所订单
/risk show
```

暂停不等待当前 agent 回合结束，也不依赖行情接口。正在等待确认的开仓会在提交前再次读取暂停状态并退回尚未提交的额度占用。状态栏和设置面板显示暂停标记，`/risk show` 显示原因和时间；`get_risk_status` 与订单预检也读取同一状态。无参数 `/risk` 仍打开设置。

暂停记录保存在 `trading-state.json`，同一数据目录、同一模式的进程共享；切换交易所、市场或报价币不会清除，`/risk reset`、`/paper reset` 和 live 跨日重置也不会解除。Paper 与 live 分别控制，不能用切换模式绕过异常排查。依赖此功能前，必须停止或升级使用同一数据目录的旧版本进程；旧版本可能忽略或丢弃暂停字段。

恢复前，先在交易所核对挂单、成交和持仓；若有未决额度占用，按下一节进行对账。然后执行 `/risk resume` 并人工确认，即使关闭了逐单确认也不能跳过此确认，非交互模式不能恢复。命令会等待当前回合结束；确认期间若运行时改变或另一进程设置了新的暂停，需要重新查看并确认。恢复只删除暂停记录，不清空已用额度、不放宽限额。

**边界**：这不是交易所总停机开关。已有订单仍可能成交，已经开始发送的请求不能被撤回；杠杆和保证金设置也不在开仓暂停范围内。现货卖单、卖出 OCO、经校验的合约减仓和平仓仍受原有单笔限额、白名单和确认策略约束，撤单仍可用。不要为解除暂停而删除状态文件，也不要盲目重试结果未知的订单。

分阶段目标见[开发计划](../../docs/product-readiness-plan.md)，故障处置和备份流程见[运维手册](../../docs/trading-operations.md)。功能落地不等于完成实盘验收；七天 Paper 运行、独立安装及授权试点仍须提供实际证据。

## 执行记录与重启对账

提交前，Ti 为普通单及 OCO 写入稳定的执行、客户端订单、订单组和腿标识；执行记录与风险占用在同一事务中保存。提交结果未知时保留记录和占用，并阻止同一数据目录中的新增敞口，不能通过清除手动暂停或切换模式绕过。减仓没有额度占用，也仍有执行记录。

```text
/recovery
/recovery run
/audit
/health
```

恢复按记录中的原始账户和客户端标识查询，只使用已有契约覆盖的查询方式。暂时查无订单、权限错误、账户不匹配、部分 OCO 证据和不完整成交数据不会被当作拒单；它们保持未决，不自动重发。已确认的挂单按保守名义额记账，后续订单变化不是每日额度的自动退款。

人工处置使用 `/recovery resolve <执行ID> commit|release <名义额> <证据引用>` 并交互确认；必须先停止其他写入者并核实交易所终态，`release` 的名义额必须为 `0`。证据引用应是本地事故记录标识，不得粘贴凭证或完整交易所响应。新记录关联的占用不能通过 `/risk reconcile` 单独清除；该命令仅保留给没有执行记录的历史独立占用。

账户替换和 Paper 重置使用持久化维护阻断，避免与另一个进程的提交交错。失败后若仍有维护记录，先停止其他写入者并核对账户与风险状态，再按 `/recovery` 显示的维护 ID 执行 `/recovery maintenance <ID> <证据引用>` 并确认。不要把清除维护记录当作完成对账。

维护成功后会推进持久化准入代次，旧进程不能在阻断解除后继续提交旧计划。`/health` 若提示运行时已过期，应使用当前配置重启该进程，再重新规划和确认；账户身份和已有执行记录不会因此改变。

风险/执行状态的文件锁不会因时间过长自动被接管。崩溃遗留锁需要核实所有写入者已停止后由操作者清理；状态文件损坏或同步失败会阻断操作，不会重建空账户来绕过错误。

## 持久化监控与实验性触发器

`/trigger add|list|remove|clear` 的定义、状态、观测基线、冷却和通知标识存入 `monitoring-state.json`，按实际账户、模式、交易所、市场、报价币和持仓模式隔离。求值只读价格与持仓，不会直接下单。缺失、非法或超过五分钟的行情时间戳视为未知，不补算未观测到的跨越。

通知通过有界待发送队列交付，携带稳定的 `monitoringEventId`；租约为 30 秒，事件五分钟后过期，过期事件只保留诊断信息，不补执行动作。同一作用域最多保留 256 条通知，终态通知按七天期限清理。

首次 Paper 交互触发可按 `wake_agent` 配置唤醒；live 触发器只通知。订单成交和持仓守护保留原有 `monitor.wakeAgent` 行为：当前运行中首次交付的新事件可在 Paper 或 live 交互会话中唤醒分析，实盘订单仍须遵守确认和风控规则。无头运行、恢复和重试通知不会唤醒交易回合。

发送后、确认写回前崩溃仍可能重复通知，应按事件标识识别重复；本地交付确认不等于会话接收端已持久保存。监控不能重建停机期间完全未观察到的开平仓过程，也不保证断电场景下超出底层持久化实现的耐久性。

## 合约说明

Binance USDⓈ-M 合约使用 ccxt unified symbol，例如 `BTC/USDT:USDT`，不是现货的 `BTC/USDT`。市场类型行为如下：

- `spot`：只允许 `BTC/USDT` 等现货交易对。
- `usdm-futures`：只允许 `BTC/USDT:USDT` 等 Binance USDⓈ-M 合约交易对。
- `both`：仅 Paper 模式可用，同时启用两个独立账户；现货和合约必须使用对应格式的交易对。

启用合约市场时运行时强制要求 `exchange` 为 `binance`，并使用 ccxt `defaultType: swap`。Paper 合约账户独立持有报价币保证金，不会使用现货余额；杠杆和保证金模式会持久化到独立的 Paper 状态文件。余额查询中的 `futures:USDT` 表示合约账户的 USDT，普通 `USDT` 表示现货账户的 USDT。

默认工具使用统一的 `get_positions` 和 `get_contract_stats`/`get_funding_rate_history`；`get_futures_positions`、`get_funding_rate` 仅保留为非默认 factory。买卖工具额外支持 `reduceOnly`、`positionSide`、`stopPrice`、`closePosition`。agent-facing 的 futures `amount` 永远是 base 数量，交易所提交数量及 amount limits 是 contracts，必须使用市场报告的 `contractSize` 转换；缺失、非线性或无法精确表示的合约元数据会拒绝下单，绝不按 1 猜。订单和持仓返回值会从 contracts 转回 base。

`closePosition` 只用于平掉匹配方向的 futures 仓位：market close 会提交准确数量并带减仓方向；live Binance USDⓈ-M 的 `stop_market`/`take_profit_market` 使用交易所 close-all 语义，可能省略 quantity。此时 `requestedAmount` 是匹配仓位快照，`amountSemantics`/`exchangeQuantitySemantics` 会说明数量来源，返回 `amount: 0` 不代表没有提交订单。hedge 模式必须同时校验 `side` 与 `positionSide`；Binance live 受交易所约束省略 wire-level `reduceOnly` 并返回 `reduceOnlyApplied: false`/`exchangeConstraint`，Paper 与其他适配器保留显式 `reduceOnly`。

Paper futures 当前只支持市价单，支持开仓、加仓、部分平仓、全平、反向开仓、加权均价、已实现/未实现盈亏、手续费和保证金校验；尚未模拟合约条件单、资金费率扣款或完整强平流程。实盘合约订单能力以 Binance 和 ccxt 当前支持为准。

## 市场数据限制

`get_price` 的 `bid`/`ask` 缺失时返回 `null` 并标记 `dataQuality`，不能据此断言流动性为零。合约分析应先调用 `get_market_info`、`get_order_book` 和 `get_contract_stats`，核对合约类型、结算资产、标记价格、指数价格、价差和未平仓量。

这些接口遵循 Binance 官方 USDⓈ-M Futures REST API 的语义：`exchangeInfo`（交易规则）、`depth`（订单簿）、`premiumIndex`（标记价/指数价/资金费率）和 `openInterest`（未平仓量）。交易所市场接口不能证明发行方、白皮书、股票映射、储备或审计；不能仅根据如 `AMD` 的交易对名称推断底层资产真实性。字段不可用时，Ti 会明确报告限制并建议回避交易。

## 验证

```bash
npm --prefix packages/trading-agent run smoke   # headless 运行时检查 + 模拟盘 E2E（真实行情，模拟成交）
```

验证脚本默认使用 `~/.ti-trader`。在 CI 或本地隔离运行时，可设置 `TI_DATA_DIR=/tmp/ti-smoke`，让配置、风控状态和模拟账户全部写入指定目录；行情请求仍需要网络连接。

## 架构

```
src/
  cli.ts / main.ts      入口与 bootstrap（复用 pi 的 services/runtime/InteractiveMode）
  args.ts               CLI 参数（--mode/--exchange/--print）
  config.ts / state.ts  配置与状态持久化（~/.ti-trader/agent/）
  context.ts            交易运行时单例：marketData、tradingEngine、配置和模式切换
  tools/index.ts         25 个原生交易工具（行情读取与交易引擎编排）
  monitor.ts              后台成交监控 + 仓位守护（裸仓/浮亏告警，唤醒 agent）
  trigger-monitor.ts      实验性 /trigger：持久化条件与状态；live 只通知
  monitoring-state.ts     账户作用域、监控状态、通知队列和健康快照
  health.ts               /health 本地执行阻断和监控健康
  commands.ts             交易 slash 命令、/recovery 对账和 /audit 审计
  prompt.ts               交易系统提示词（整体替换编码提示词）

packages/trading-engine/  独立交易引擎：规范化合约、ccxt/paper 适配器、规划、风控和保护逻辑
extensions/
  web-search/           可选只读公开互联网研究扩展（独立安全策略）
  zhihu-research/       可选只读知乎全网搜索扩展（官方 OpenAPI）
```
