# Ti — AI 交易助手

npm 包名 `ti-trader`，命令 `ti`。仓库总览见根目录 [README](../../README.zh-CN.md)；本文是安装后的使用说明和操作参考。

Ti 跑在终端里。用自然语言看盘、在模拟盘试单；实盘默认仍要你确认每一笔。它不是 coding agent 外挂交易所：[Pi](https://github.com/earendil-works/pi) 的 `read` / `bash` / `edit` / `write` 已去掉，`buy` / `sell` 是一等工具。密钥只留本机。

> 启用 live 后可能亏光账户。Ti 不是投资建议。先用 paper，收紧风控，API key **不要**开提现。超时或进程退出不会撤销已经到达交易所的订单。

一次典型对话：

```text
你:  分析 BTC 1h。如果结构允许，用 100 USDT 在模拟盘买入。
Ti:  读 K 线 / 指标 / 余额 → check_order → paper 成交
```

`check_order` 只读预检，不预留额度、不提交。实盘最后一步是确认框。

## 安装

需要 Node.js `>= 22.19.0`。

```bash
npm install -g ti-trader
ti --version
ti                          # 交互模式，默认 paper
ti -p "分析 BTC 1h 走势"     # 一次性无头
```

不要用 `sudo` 往系统 npm 装。若出现 `EACCES`：

```bash
mkdir -p ~/.npm-global
npm config set prefix "$HOME/.npm-global"
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
npm install -g ti-trader
```

Ti 与 Pi 的配置完全隔离。首次启动创建 `~/.ti-trader/agent/`，不读写 `~/.pi/`。模型用 `/login`，交易所 key 用 `/exchange-login`。

## 第一次运行

1. `/login` 配模型。
2. 留在 paper，不必配交易所 key。
3. `/settings` 设语言、风控上限、市场。
4. 真要实盘再用 `/exchange-login`。

交易所：Binance（现货与 USDⓈ-M 覆盖最完整）、OKX、Bybit（后两者 experimental）。语言、模式、市场类型在 `/settings`，写入 `~/.ti-trader/agent/trading.json`。模型认证 `auth.json`，交易所 key `keys.json`（权限 600）。

可选扩展在仓库 `extensions/`，发布时打进 `ti-trader/dist/`。默认只自动加载 `market-lab` 和 `market-chart`（只读，不下单）。其余按环境变量或 `--extension` 加载；`--no-extensions` 关掉用户扩展发现：

- `web-search`：`TAVILY_API_KEY` 非空
- `zhihu-research`：`ZHIHU_ACCESS_SECRET` 非空，或密钥文件有内容。默认 `~/.ti-trader/agent/zhihu-access-secret`，可用 `TI_ZHIHU_ACCESS_SECRET_FILE` 覆盖
- `market-research`：`TI_MARKET_RESEARCH` 为 `1` / `true` / `yes`
- `subagent`：`TI_SUBAGENT` 为 `1` / `true` / `yes`。只读隔离子代理，不能交易
- `freqtrade`：`TI_FREQTRADE_URL` 非空。本机 Freqtrade webserver 回测侧车，不下单；仅 `--extension` 时 URL 才回落到 `http://127.0.0.1:8080`

默认 25 个原生交易工具（行情、账户、预检、买卖、风控）加上 market-lab / market-chart。清单与参数见 [DESIGN.md](DESIGN.md)。交易所连接、规划、风控在 `@nikopack/ti-trading-engine`。

## 从源码运行

```bash
npm install --ignore-scripts
cd packages/coding-agent && npm run build:unbundled && cd ../..
npm run build:trading
node packages/trading-agent/dist/cli.js
node packages/trading-agent/dist/cli.js -p "分析 BTC 1h 走势并说明是否适合开多"
node packages/trading-agent/dist/cli.js --mode live --exchange binance
```

根 `npm run build` 里 coding-agent 的 esbuild 打包在本机有已知的 `<runtime>` external 报错（上游问题）。`build:unbundled` 即本包所需。

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
	"orderApproval": "unattended",
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

买卖工具支持五种条件单类型；Paper 现货和 Paper 合约都用公开行情懒撮合这些类型，live 的具体支持取决于交易所。Paper 合约不支持 OCO：

- `stop` / `stop_market`：价格向不利方向触及 `stopPrice` 时触发（卖单跌到触发价 = 止损；买单涨到触发价 = 突破追入）。`stop` 触发后以 `price` 挂限价单，`stop_market` 触发即成交。
- `take_profit` / `take_profit_market`：价格向有利方向触及 `stopPrice` 时触发（卖单涨到触发价 = 止盈）。
- `trailing_stop_market`：`trailingPercent` 移动止损。卖单跟踪下单以来的最高价，回撤给定百分比即触发；买单跟踪最低价，反弹给定百分比触发。
- `place_oco`：仅用于现货的 OCO 括号单，一次同时挂止损（`stopLossPrice`）与止盈（`takeProfitPrice`），任一腿成交自动撤销另一腿；撤销任一腿等于撤销整组。合约仓位应改用一个 `reduceOnly` 保护单。

下单时触发条件已满足会被直接拒绝（与交易所行为一致）。

`check_order` 是只读预检，不会预留额度或提交订单。`status` 可能为 `ok`、`ok_with_warnings`、`rejected` 或 `unknown`：`ok` 可直接执行，`ok_with_warnings` 只有在逐条审阅并接受 warnings 后才可执行，`rejected`/`unknown` 必须停止。live futures 的手续费和维护保证金数据目前由适配器明确标记为非阻断 warning，最终仍以交易所接受或拒绝为准；市场、余额或合约单位证据缺失仍是 blocking unknown。

Paper 现货和 Paper 合约的触发在每次账户读取时懒惰撮合：所有挂单（限价/触发/移动止损）都用 1m/15m/1h K 线回填两次读取之间的最高/最低价，不会漏掉读取间隙里的价格波动。合约保护单须 `reduceOnly`。实盘通过 ccxt 统一参数（`stopLossPrice`/`takeProfitPrice`/`trailingPercent`）下发，OKX 等交易所的算法单会自动合并进 `get_open_orders`，撤单自动带 `trigger`/`trailing` 参数重试；具体类型支持以交易所为准。

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

Paper futures 支持市价、限价、止损、止盈和移动止损，以及开仓、加仓、部分平仓、全平、反向开仓、加权均价、已实现/未实现盈亏、手续费和保证金校验；不模拟资金费率扣款、滑点、部分成交或交易所特定强平，也不接受合约 OCO。实盘合约订单能力以 Binance 和 ccxt 当前支持为准。

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
  market-lab/           默认只读量化（指标、筛选、回放）
  market-chart/         默认只读图表（show_market_view /chart）
  market-research/      按需加载的市场研究子代理（TI_MARKET_RESEARCH）
  subagent/             按需加载的只读隔离子代理（TI_SUBAGENT）
  web-search/           按需加载的公开互联网研究（TAVILY_API_KEY）
  zhihu-research/       按需加载的知乎全网搜索（ZHIHU_ACCESS_SECRET 或密钥文件）
  freqtrade/            按需加载的本机 Freqtrade 回测侧车（TI_FREQTRADE_URL）
```
