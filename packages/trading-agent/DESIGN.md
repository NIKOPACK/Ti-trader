# Ti 功能设计文档

> 版本：0.1.11（当前开发工作区版本，未声明已发布）　·　基于 pi agent harness（`@earendil-works/pi-coding-agent` 0.84.3）二开
> 最后更新：2026-09-11

---

## 1. 产品定位

Ti 是一个 **AI 驱动的加密货币现货与 Binance USDⓈ-M 合约交易 agent CLI**。它将 pi 的编码 agent 深度改造为交易 agent：

- **原生交易能力**：买卖下单是 agent 的内置工具（非扩展、非 shell 变通），LLM 通过结构化工具调用直接操作交易所账户。
- **编码能力移除**：`read` / `bash` / `edit` / `write` / `grep` / `find` / `ls` 全部禁用，系统提示词整体替换为交易领域提示词。
- **安全优先**：默认模拟盘（真实行情 + 虚拟资金），实盘需要显式开启并经过多层确认，风控限额由运行时强制执行。

目标用户：希望用自然语言驱动 AI 进行市场分析、模拟盘验证策略、并在严格风控下半自动/自动执行现货或合约交易的用户。

### 1.1 与上游 pi 的关系

```
┌─────────────────────────────────────────────────────────┐
│                        Ti (本包)                          │
│  交易工具 · 交易命令 · 运行时装配 · 交易提示词              │
├─────────────────────────────────────────────────────────┤
│         @earendil-works/pi-coding-agent（库引用）          │
│  AgentSession SDK · InteractiveMode TUI · 会话/设置/认证   │
├─────────────────────────────────────────────────────────┤
│  pi-agent-core（agent 运行时）· pi-ai（多模型统一 API）     │
├─────────────────────────────────────────────────────────┤
│  @nikopack/ti-trading-engine（适配器 · 规划 · 风控） │
│  ccxt（交易所统一 API，100+ 交易所）                        │
└─────────────────────────────────────────────────────────┘
```

关键设计决策：**以库方式复用 pi-coding-agent，不 vendor 源码**。上游更新只需升级依赖版本并重构建。编码功能的"删除"是会话装配期的运行时裁剪（`noTools: "builtin"` + 自定义提示词 + 自定义工具集），不改动上游一行代码。

源码边界：`packages/trading-agent` 负责运行时装配、配置与持久化、agent 工具、命令、监控和提示词；`packages/trading-engine` 负责规范化合约、ccxt/paper 适配器、订单规划、保护、风险预留和 `TradingEngine`。agent 通过 `marketData` 读取数据，通过 `tradingEngine` 进行规划、风控、确认和提交。

---

## 2. 功能总览

| 模块 | 功能 | 状态 |
|---|---|---|
| 交易工具 | 行情、账户、订单生命周期、下单预检、能力查询、候选市场、组合快照和风控，共 25 个 | ✅ |
| 交易命令 | Ti 命令（余额、持仓、订单、市场、模式、交易所、市场类型、风控含 reconcile、Paper、监控、实验性 `/trigger`、语言和交易所登录） | ✅ |
| 交易引擎 | `@nikopack/ti-trading-engine`：ccxt 实盘客户端、模拟盘客户端、统一 `ExchangeClient`、规划、保护和风控 | ✅ |
| 模拟盘 | 真实行情撮合、手续费、均价成本、PnL、跨进程持久化 | ✅ |
| 风控 | 单笔/单日名义限额、币种白名单、日计数持久化、未结算 reservation 对账 | ✅ |
| 安全 | paper 默认 `unattended`、live 默认 `confirm`（key/切换确认/逐单确认；live 切到 `unattended` 需确认）、无头保护 | ✅ |
| 模型层 | 继承 pi：OpenAI/Anthropic/Google 等多 provider、`/login`、`/model` | ✅（上游） |
| 会话层 | 继承 pi：会话持久化、`/new` `/resume` `/fork` `/compact` 等 | ✅（上游） |
| 自动化 | `--print` 无头一次性模式 | ✅ |
| 事件驱动 | 实验性内存 `/trigger`（通知/paper 唤醒；live 只通知）；WebSocket 行情推送 | 部分 |
| 定时任务 | cron 式自动运行 | ❌ 未实现 |
| 合约/杠杆 | Paper 与 Binance USDⓈ-M live：杠杆、保证金模式、持仓方向、reduceOnly；Binance live 支持资金费率查询，Paper 不模拟资金费率扣款或历史 | ✅ v1 |
| 回测 | 历史数据回放 | 可选 `freqtrade` 扩展：本机 webserver 侧车；默认不加载，不进入下单路径 |

---

## 3. 交易工具（agent 原生工具）

工具通过 `createAgentSessionFromServices({ noTools: "builtin", customTools: [...] })` 注入，LLM 侧看到的是标准 tool schema（typebox 定义），TUI 侧有默认渲染。

默认工具集固定为 25 个，按职责分为：行情 `get_price`、`get_order_book`、`get_market_info`、`get_contract_stats`、`get_klines`、`get_top_markets`；能力与账户 `get_trading_capabilities`、`get_balance`、`get_positions`、`get_portfolio_snapshot`、`get_open_orders`、`get_order_history`；查询与预检 `get_order_status`、`get_order_list_status`、`check_order`；执行 `buy`、`sell`、`place_oco`、`cancel_order`、`cancel_order_list`；风控与合约设置 `get_risk_status`、`get_funding_rate_history`、`set_leverage`、`set_margin_mode`、`set_multi_assets_mode`。`get_funding_rate` 与 `get_futures_positions` 仍保留 factory 导出，但不进入默认 agent 工具，避免重复语义。

### 3.1 行情类

#### `get_price`
获取单个市场最新行情。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `symbol` | string | ✅ | ccxt 格式，如 `BTC/USDT`，quote 必须与配置的报价币种一致 |

返回：`last` / `bid` / `ask` / `high24h` / `low24h` / `changePct24h` / `volume24h` / `quoteVolume24h` / `time`。

#### `get_klines`
获取 OHLCV K 线，用于趋势/动量分析。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `symbol` | string | ✅ | 同上 |
| `timeframe` | string | 否 | `1m` `5m` `15m` `1h` `4h` `1d` 等，默认 `1h` |
| `limit` | number | 否 | 根数，默认 100，上限 200 |

返回：紧凑数组 `[ISO时间, open, high, low, close, volume]`，最旧在前。限制 200 根是为了控制 LLM 上下文体积。

### 3.2 账户类

#### `get_balance`
非零资产余额 + 按当前市价折算的报价币估值。返回总额 `totalQuoteValue` 与每个资产的 `free` / `used` / `total` / `quoteValue`。

#### `get_positions`
当前现货持仓（剔除报价币、剔除 < 1 quote 的粉尘）。paper 模式额外返回：

- `avgEntryPrice`：含手续费的加权平均成本
- `unrealizedPnl` / `unrealizedPnlPct`：按最新价计算的浮动盈亏

live 模式的现货在交易历史完整且能与余额核对时返回手续费感知的成本基础；历史、手续费或余额无法核对时明确标记成本基础不可用，只返回估值。

#### `get_open_orders`
当前未成交订单，可选 `symbol` 过滤。paper 模式调用时会先触发一次挂单撮合检查（见 §5.3）。

#### `get_order_history`
最近已完结订单（成交/撤销），可选 `symbol` 与 `limit`（默认 20，上限 100）。

#### `get_portfolio_snapshot`
一次读取余额、持仓、未成交订单和风险额度，并返回估算权益、总敞口、未实现盈亏及数据质量。无法估值的资产或订单会标记为 `partial`/`null`，不能当作 0。

#### `get_top_markets`
按配置报价币的 24h 成交量返回有限数量的候选市场。排名只用于发现市场，不代表趋势或交易建议；下单前仍须核对市场元数据、能力和实时行情。

#### `get_trading_capabilities`
可选传入 `symbol`，返回当前交易所和模式对订单类型、OCO、移动止损、期货仓位控制、资金费率及 client-id 查询的支持状态。`unknown` 表示适配器没有足够证据，不能推断为支持。

### 3.3 交易类

#### `buy`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `symbol` | string | ✅ | |
| `type` | `market` \| `limit` | ✅ | |
| `amount` | number | 二选一 | base 数量，如 0.01 BTC |
| `quoteAmount` | number | 二选一 | quote 金额，如 100 USDT（按参考价折算 base 数量） |
| `price` | number | 限价必填 | |

#### `sell`

参数同 `buy`。`amount` 为 base 数量；`quoteAmount` 表示"卖出价值 X quote 的持仓"。

#### `check_order`

与 `buy`/`sell` 使用相同订单字段并额外要求 `side`。该工具只做下单前预检：解析 `quoteAmount`、选择参考价、匹配平仓仓位、计算名义金额和风险影响，不预留额度、不确认、不提交订单。状态分为 `ok`、`ok_with_warnings`、`rejected`、`unknown`：`ok` 可直接继续，`ok_with_warnings` 必须逐条审阅并接受 warnings 后才能继续，`rejected` 与 `unknown` 必须阻断；live futures 手续费/维护保证金未知属于明确的非阻断 warning，市场、余额或合约单位证据未知仍阻断。即使返回 `ok` 也不等于交易所已接受，精度、过滤器和触发状态仍由最终下单适配器复核。

**下单执行流水线**（buy/sell 共用）：

```
参数校验 → 取参考价（限价单用指定价，市价单用卖一/买一）
  → 折算 base 数量与名义金额
  → 风控检查（§6）          ┐
  → live 且需确认 → 弹确认框  ├ 任一环节失败即抛错给 LLM
  → 交易所下单               │
  → 记录当日名义用量          ┘
  → 返回成交结果（含手续费）
```

设计要点：
- 市价买入用 `quoteAmount` 是最自然的表达方式（"买 100 U 的 BTC"），工具按参考价折算 base 数量；行情变化时不保证最终成交金额固定。
- `price` 只用于 `limit`、`stop`、`take_profit` 的限价执行；`stopPrice` 只用于条件触发或实盘支持的移动止损激活价。不适用字段会直接拒绝，避免预检使用一个最终不会提交的价格。
- 止损/止盈触发价必须位于当前价的正确方向；会立即触发的订单在共享 planner 中拒绝。Paper 移动止损不支持激活 `stopPrice`。
- 工具抛出的错误（余额不足、超限）会作为 tool result 返回给 LLM，agent 可以据此调整策略重试——这是 agent 自我纠错的关键路径。

#### `cancel_order`
按订单 id 撤销未成交单（id 从 `get_open_orders` 获取）。

### 3.4 风控类

#### `get_risk_status`
返回当前风控配置、权威已用额度（`usage.used`）和未结算 reservation 列表。paper 额度为累计制，live 按日。未结算占用不是重试许可；用户核对交易所后用 `/risk reconcile` 结算。

---

## 4. Slash 命令（用户侧）

命令通过**内联 extension factory** 在会话装配期注册（与内置命令同等待遇：自动补全、帮助可见）。输出渲染为会话流中的持久卡片（custom entry + renderer），**不进入 LLM 上下文**，不污染对话。

| 命令 | 功能 | 说明 |
|---|---|---|
| `/balance` | 账户总览 | 各资产 free/locked/估值 + 总估值 |
| `/positions` | 持仓明细 | 数量、估值、均价、浮动盈亏（paper） |
| `/orders [symbol]` | 未成交订单 | |
| `/trades [symbol]` | 历史订单 | 最近 20 条已完结订单 |
| `/markets [n]` | 热门市场 | 按 24h quote 成交量排序，默认前 15，上限 50 |
| `/mode [paper\|live]` | 查看/切换交易模式 | 切 live 需二次确认且有 key 校验；配置持久化后下次启动不再确认 |
| `/approval [confirm\|unattended]` | 实盘订单审批 | 默认逐单确认；切到 `unattended` 需交互确认，之后 live 下单不再弹框 |
| `/exchange [id]` | 查看/切换交易所 | ccxt 交易所 id，如 `okx` `bybit` |
| `/market [type]` | 查看/切换市场类型 | `spot`、`usdm-futures` 或 `both`（`both` 仅 Paper） |
| `/risk [show\|reset\|reconcile <id> commit\|release]` | 风控状态 | 限额、已用/预留额度、未结算占用；`reset` 二次确认后手动清零（paper 额度为累计制）；`reconcile` 在核对交易所后结算卡住的占用 |
| `/trigger add\|list\|remove\|clear` | 实验性条件监控 | 内存定义，只读行情/持仓；live 下 `wake_agent` 只通知，不自动拉起交易回合 |
| `/paper [reset [金额]]` | 模拟账户 | 查看摘要；`reset` 二次确认后重置资产（可指定初始 USDT） |
| `/monitor [on\|off]` | 后台监控 | 成交监控 + 仓位守护的状态与本会话开关 |
| `/exchange-login [id]` | 配置交易所 API | 交互录入 Binance（币安）、OKX、Bybit 凭证 |

#### `/language [zh-CN|en-US]`
切换 TUI 语言。无参数时显示中文和 English 选择菜单，设置保存到 `trading.json`，并影响 Ti 系统提示词的回复语言。

另继承 pi 通用命令：`/model` `/logout` `/new` `/resume` `/fork` `/compact` `/export` `/settings` `/quit` 等。`/login` 负责模型 Provider 登录；交易所凭证使用 Ti 自己的 `/exchange-login`。

---

## 交易引擎边界

`packages/trading-engine` 是 framework-independent 的独立包，拥有规范化交易合约、ccxt/paper 适配器、订单规划、保护逻辑、风险预留和 `TradingEngine` 编排。它不依赖 agent、LLM、TUI 或扩展。`packages/trading-agent` 负责持久化、配置、会话、工具、命令、监控和提示词，并构造一致的 client/engine。

`TradingRuntime` 将 `marketData` 作为只读数据边界，将 `tradingEngine` 作为规划、风控、确认和提交边界暴露给 agent；agent 不维护第二套交易所或风控实现。

源码树：

```
packages/trading-agent/src/
  context.ts       运行时装配与 client/engine 生命周期
  tools/           agent 原生交易工具
  commands.ts      交易 slash 命令
  monitor.ts       成交监控与仓位守护
  trigger-monitor.ts 实验性 /trigger 内存监控
  config.ts/state.ts  配置与状态持久化
packages/trading-engine/src/
  types.ts         规范化交易合约
  ccxt-client.ts / paper-client.ts  实盘与模拟盘适配器
  order-plan.ts / risk.ts / protection.ts 规划、风险与保护
  engine.ts        TradingEngine 编排
```


## 5. 交易所抽象层

### 5.1 统一接口

统一 `ExchangeClient`、适配器、订单规划、保护和风控由 `@nikopack/ti-trading-engine` 提供。

```ts
interface ExchangeClient {
  readonly id: string;
  readonly mode: "paper" | "live";
  readonly quoteCurrency: string;
  getTicker(symbol): Promise<Ticker>;
  getKlines(symbol, timeframe, limit): Promise<Kline[]>;
  getBalances(): Promise<Balance[]>;
  getPositions(): Promise<Position[]>;
  getOpenOrders(symbol?): Promise<Order[]>;
  getOrderHistory(symbol?, limit?): Promise<Order[]>;
  placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult>;
  cancelOrder(id, symbol): Promise<void>;
  getTopMarkets(limit): Promise<Ticker[]>;
  close(): Promise<void>;
}
```

工具与命令只依赖此接口，paper/live 对上层完全透明。

### 5.2 实盘客户端（`CcxtExchangeClient`）

- 基于 ccxt 4.5.58（pinned），REST 轮询，`enableRateLimit: true`。
- 凭证来自 `~/.ti-trader/agent/keys.json`（写入时 chmod 600）。
- 估值：`getBalances` 对每个非零资产单独取价折算 quote。
- 已知边界：Binance 对中国大陆等区域返回 HTTP 451，故**默认交易所为 OKX**（`/exchange` 可切）。

### 5.3 模拟盘引擎（`PaperExchangeClient`）

用**真实公共行情**（无钥匙 ccxt 实例）驱动一个本地虚拟账户：

- **初始资金**：`paper.startQuote`（默认 10,000 quote）。
- **市价单**：以最新成交价立即成交，扣手续费 `feeRate`（默认 0.1%，买卖双向）。
- **限价单**：下单时预冻结资金/持仓（防止并发超支）；**懒撮合**——每次账户读取操作（balance/positions/orders）检查最新价是否穿越限价，穿越即以限价成交。Paper 合约挂单走同一套路径，开仓冻结保证金，减仓锁仓位。
- **成本与盈亏**：买入按"数量+费用"计入加权平均成本；卖出按先进成本计算已实现盈亏（累计 `realizedPnl`），持仓显示浮动盈亏。
- **持久化**：`~/.ti-trader/agent/paper/<exchange>-<QUOTE>.json`，进程重启不丢失。
- **余额校验**：不足时抛出与真实交易所语义一致的错误（`Insufficient USDT: need X, have Y (paper account)`），让 agent 在模拟中就能学会处理资金约束。

有意简化（v1）：无部分成交、无滑点、无盘口深度模拟、不支持全历史回放。

---

## 6. 风控系统

风控由 `@nikopack/ti-trading-engine` 的 `TradingEngine` 强制执行，**LLM 无法绕过**（与提示词里的软约束形成双保险）。`TradingRuntime` 负责配置加载、持久化和 client/engine 生命周期，并将 `marketData` 与 `tradingEngine` 分开暴露。

```json
"risk": {
  "maxOrderNotional": 500,    // 单笔名义上限（quote）
  "maxDailyNotional": 2000,   // 累计名义上限（quote）：live 按日、paper 累计制
  "allowedSymbols": []        // 交易对白名单，空 = 不限
}
```

- 任一规则违反 → 下单工具直接抛错（`Risk limit: ...`）。
- **额度计数持久化**在 `trading-state.json`（UTC 日期 + 已用额度 + 未结算 reservations），重启进程不会重置风控账本。in-flight reservation 必须 round-trip，不能在类型层丢掉。
- **提交结果未知**时引擎会把额度 commit 进 used（只结算一次）。若 commit 本身失败，reservation 保持 pending：启动时告警，`/risk` 与 `get_risk_status` 列出；用户核对交易所后用 `/risk reconcile <id> commit|release` 结算，不要重试原订单。
- **重置策略按模式区分**：live 模式跨日自动清零已用额度（日额度语义），未结算 reservation 会结转到下一日；paper 模式**不自动清零**，额度累计消耗，只能由用户手动重置——`/risk reset`（仅清额度）或 `/paper reset`（重置模拟资产时一并清零）。agent 无法自行恢复额度。
- 限额修改只能由用户编辑配置文件完成，agent 没有修改风控的工具——这是刻意的权限不对称。

## 7. 安全模型

| 层 | 机制 |
|---|---|
| 默认安全 | 首次运行即 paper 模式；live 必须显式开启 |
| 凭证隔离 | 交易所 key 独立存放于 `~/.ti-trader/agent/keys.json`（0600），与模型凭证分离 |
| 切换确认 | `/mode live` 需交互确认，且预先校验该交易所 key 存在。切到 live 后写入 `trading.json`，下次启动按已保存模式进入，不再弹启动确认 |
| 逐单确认 | Paper 默认 `orderApproval: "unattended"`，live 默认 `"confirm"`。live+confirm 每笔订单弹确认框。live+unattended 必须经 Settings 或 `/approval unattended` 交互确认后才能开启。切换模式会套用该模式的默认审批，除非同一次 patch 显式带了 `orderApproval` |
| 无头保护 | `--print`/RPC 等无 UI 场景下，若审批仍是 `confirm`，live 下单一律拒绝——防止无人值守时误触实盘 |
| Trigger | 实验性 `/trigger` 不是下单授权。live 与 `--print` 从不因 trigger 自动唤醒 agent |
| 提示词约束 | 系统提示词内置仓位比例、下单前查余额、下单后必验证等规则（软约束） |

模型 auth 沿用 pi 的机制（`/login` OAuth 或 API key），存储在 `~/.ti-trader/agent/auth.json`，**与 pi coding agent 的 `~/.pi` 完全隔离**。

## 8. 系统提示词设计

整体替换编码提示词（`resourceLoaderOptions.systemPrompt`），核心结构：

1. **身份**：Ti，明确当前是 SIMULATED 还是 LIVE（配置注入，运行时烘焙）
2. **操作循环**：观察 → 分析 → 决策（论点/入场/失效位/仓位）→ 执行 → 验证
3. **风控硬规则**：限额数值直接写入提示词；单仓建议 ≤10-20%；买前查余额、卖前查持仓
4. **工具用法**：参数语义（quoteAmount vs amount）、klines 数据格式说明
5. **输出规范**：结论先行、带符号的百分比、必须报告成交与费用、禁止谎报已成交

同时禁用了编码向的资源加载：`noContextFiles`（不读 AGENTS.md）、`noSkills`（不加载技能文件）。

## 9. CLI

```
ti [options] [message...]
  --mode <paper|live>   交易模式（覆盖配置文件，仅本次会话）
  --exchange <id>       ccxt 交易所 id
  -p, --print           无头一次性执行（管道友好，可接 cron/脚本）
  --no-extensions       不加载用户扩展
  --verbose             详细输出
  -h, --help  -v, --version
```

会话数据按 cwd 分目录存储（`~/.ti-trader/agent/sessions/--Users-xxx-project--/`），沿用 pi 的编码规则。

## 10. 配置与状态文件

```
~/.ti-trader/agent/
  trading.json         交易配置（模式/交易所/报价币/风控/模拟参数）
  trading-state.json   风控日计数与未结算 reservations（自动维护，勿手改；对账用 /risk reconcile）
  keys.json            交易所 API 凭证（0600）
  auth.json            模型 provider 凭证（pi 机制）
  settings.json        TUI/模型等设置（pi 机制）
  paper/<ex>-<Q>.json  模拟账户（余额/挂单/成交/成本/已实现盈亏）
  sessions/            会话记录
```

`trading.json` 完整 schema：

```json
{
  "mode": "paper",
  "exchange": "okx",
  "quoteCurrency": "USDT",
  "orderApproval": "unattended",
  "risk": { "maxOrderNotional": 500, "maxDailyNotional": 2000, "allowedSymbols": [] },
  "paper": { "startQuote": 10000, "feeRate": 0.001 }
}
```

## 11. 构建与验证

发布时先发布 `@nikopack/ti-trading-engine`，再更新其 exact dependency 并发布 `ti-trader`；真实 npm 发布需要 maintainer authority。

```bash
npm install --ignore-scripts
cd packages/coding-agent && npm run build:unbundled && cd ../..
npm run build:trading          # 先构建 tui、triggers 与 trading-risk，再构建 trading-engine，最后构建 trading-agent
npm --prefix packages/trading-agent run smoke   # 运行时检查 + 模拟盘 E2E
```

两个 smoke 脚本：

- `scripts/runtime-check.mjs`（无头）：验证装配正确性——工具表精确匹配（无编码工具泄漏）、交易提示词生效、交易命令注册、风控拦截/放行逻辑、默认 paper。
- `scripts/paper-smoke.mjs`（E2E）：真实行情下完整走一遍 Paper spot 买入→持仓 PnL→限价单挂/撤→卖出→热门市场，并校验费用核算；Paper futures 同样模拟限价和条件单，但不接受 OCO。

**已知上游问题**：根构建链中 coding-agent 的 esbuild 打包步骤在本机报 `<runtime>` external 错误（上游环境问题，与二开无关）；`build:unbundled` 产物即本包全部所需。

## 12. 产品化完成项

在 0.1.0 MVP 基础上，已补齐以下产品化基础能力：

- 配置文件严格校验：损坏 JSON、非法模式、非法报价币、负风险限额、非法 paper 参数会 fail-closed，不再静默回退。
- JSON 状态文件使用临时文件 + rename 原子替换，降低进程崩溃造成半文件的风险。
- 模式/交易所切换采用先创建新 client、成功后再提交配置的事务顺序，切换失败保持旧状态。
- 订单统一校验报价币种；`amount` 与 `quoteAmount` 必须严格二选一且必须为正的有限数。
- 实盘交易初始化市场信息，校验请求的市场族/类型、报价币、最小数量和最小名义金额，并按交易所规则格式化数量和价格。
- paper 限价买单冻结手续费，避免成交时余额不足；限价成交保留原订单 ID，避免订单历史重复。
- paper 订单历史支持 symbol 过滤。
- 增加 CLI、配置校验、风控状态的自动化测试；测试命令为 `vitest --run src test`，覆盖源码和测试目录；保留 runtime-check 和网络 smoke 作为集成验证。

当前风险额度仍按“下单名义金额”计入，而不是实际成交额。这是 v1 的保守策略：未成交挂单也会占用额度，防止通过大量挂单绕过日限额。风险状态和 API 凭证均在读写时做结构校验；风险状态损坏会拒绝启动，凭证损坏会拒绝使用。

## 13. Binance USDⓈ-M 合约 v1

合约模式通过 `marketType: "usdm-futures"` 开启，并且严格限制 `exchange: "binance"`。统一 symbol 使用 ccxt 合约格式，例如 `BTC/USDT:USDT`。

### 支持参数

- 配置：`leverage`（1–125）、`marginType`（`isolated`/`cross`）、`positionMode`（`one-way`/`hedge`）。
- 下单：Paper futures 支持 market、limit 和与 Paper spot 相同的条件单类型（`stop` / `stop_market` / `take_profit` / `take_profit_market` / `trailing_stop_market`），不支持 OCO。live futures 的具体类型支持取决于 Binance/ccxt 适配器及交易所能力。futures-only 参数包括 `reduceOnly`、`positionSide`（`BOTH`/`LONG`/`SHORT`）和 `closePosition`。
- 默认工具：统一的 `get_positions`、`get_contract_stats`、`get_funding_rate_history`，以及 `set_leverage`、`set_margin_mode`、`set_multi_assets_mode`；`get_funding_rate` 与 `get_futures_positions` 仅保留为非默认 factory。
- 仓位：合约数量、方向、杠杆、保证金模式、标记价格、强平价格、初始保证金、未实现 PnL。agent-facing 数量始终是 base 资产数量，交易所数量和数量限制是 contracts。

### Binance API 映射

ccxt client 仅在 Binance USDⓈ-M 模式设置 `options.defaultType = "swap"`，并使用 ccxt `fetchPositions`、`fetchFundingRate`、`setLeverage`、`setMarginMode` 和 `createOrder` 参数映射 Binance 的 `/fapi/v1/order`、`/fapi/v1/leverage`、`/fapi/v1/marginType` 等接口。

Paper client 使用独立的 futures 账户和报价币保证金，不把现货余额伪装成合约保证金；限价和条件单与 Paper spot 一样按公开行情懒撮合，不模拟资金费率扣款、滑点、部分成交或交易所特定强平。

### 安全边界

- 合约市场只允许 Binance；Paper 可用于本地模拟，live 使用 Binance USDⓈ-M，不能通过切换模式绕过市场族校验。
- agent 输入的 base 数量在 adapter 边界按 `contractSize` 转成 contracts；订单/持仓返回再转回 base。缺失或无效 `contractSize`、非线性合约、以及无法精确落在合约精度网格的数量都会显式拒绝，绝不静默按 1 猜。
- Binance 市场规则仍由 `exchangeInfo`/ccxt markets 校验数量、精度和最小名义金额；Binance trigger close-all（`stop_market`/`take_profit_market` + `closePosition`）由交易所省略 quantity，预检和结果必须区分 `requestedAmount` 与交易所数量。
- hedge 模式的减仓先验证 `side` 与 `positionSide`（LONG 只能 sell、SHORT 只能 buy）。Binance live USDⓈ-M 因交易所约束省略 wire-level `reduceOnly`，结果显式返回 `reduceOnlyApplied: false` 与 `exchangeConstraint`；Paper 和其他适配器保留 `reduceOnly`。
- 交易所接受订单不等于成交；订单和仓位必须通过查询确认。
- `positionMode` 是配置声明，Binance 对冲模式切换需要在账户层显式 API 操作，当前版本不自动切换账户模式；使用 `positionSide` 前应确保账户模式匹配。

## 13.5 止盈止损与移动止损

条件单能力按市场模式区分：Paper spot 与 Paper futures 支持五种条件单类型；live spot/futures 是否支持这些类型取决于 ccxt 适配器及具体交易所。五种类型为：`stop`、`stop_market`（止损：价格向不利方向触及 `stopPrice`）、`take_profit`、`take_profit_market`（止盈：价格向有利方向触及 `stopPrice`）、`trailing_stop_market`（`trailingPercent` 百分比回撤移动止损）。带 `_market` 后缀的类型触发即按触发价成交；`stop`/`take_profit` 触发后转为 `price` 限价单继续挂单。下单时触发条件已满足会被拒绝（对齐交易所「would immediately trigger」行为）。Paper futures 不支持 OCO，保护单应使用 `reduceOnly`。

**Paper 撮合**：Paper 现货和合约的所有挂单在每次账户读取时懒惰结算。

Paper 触发单按触发价成交、限价单按限价成交（与真实滑点相比略乐观，但确定性强且与资金预留一致）。现货资金预留按最坏成交价计算：买入触发单按 `stopPrice`（或限价）冻结含手续费的报价币；移动止损买单按下单时刻的止损位（trough 只会下移，故为上界）冻结。合约开仓挂单按预留价冻结保证金加手续费；`reduceOnly`/`closePosition` 不额外冻结保证金，但会锁住对应仓位数量，仓位被市价平掉或强平后自动撤销。移动止损用 `trailingExtreme` 持久化跟踪峰值/谷值：每次结算先用 ticker 采样；两次读取间隔超过 2 分钟时按间隔选择 1m/15m/1h K 线回填，逐根 K 线「先用之前的极值判定触发、再用本根 K 线更新极值」，避免同根 K 线先创高后触发的次序歧义。`lastCheckedAt` 每次结算推进，保证回填窗口不重叠、不会用乱序数据误触发。

**Live 映射**：不把 Binance 风格类型名直接传给交易所，而是映射到 ccxt 统一契约——执行类型 market/limit + `stopLossPrice`/`takeProfitPrice`/`trailingPercent`（可选 `trailingTriggerPrice` 激活价），由 ccxt 翻译为各交易所参数（Binance `STOP_LOSS`/`TRAILING_STOP_MARKET`/callbackRate，OKX 条件单/`move_order_stop`/callbackRatio 等）。OKX 类交易所把算法单放在独立端点：`getOpenOrders` 会 best-effort 追加 `{trigger: true}`、`{trailing: true}` 查询并按订单 id 去重合并；`cancelOrder` 失败时自动带同样参数重试。交易所不支持的类型会以其原始错误拒单。

## 13.6 OCO 括号单

`place_oco(symbol, side, amount, stopLossPrice, takeProfitPrice)` 仅用于现货，一次挂出止损 + 止盈两腿，任一腿成交自动撤销另一腿。这是现货入场成交后的首选保护方式（系统提示词也如此引导）；合约不支持 OCO。

**Paper spot**：两腿共享 `ocoGroup` id，止损腿先入队（同一根 K 线两个触发价都被穿越时保守判止损成交）；整组只做一次资金预留（买向 OCO 按两腿较高触发价冻结）；成交一腿释放预留并撤另一腿，手动撤任一腿等于撤整组。K 线回填对两腿联合评估，取先被穿越者成交。

**Live**：通过 ccxt `createOrder` 同时携带 `stopLossPrice` + `takeProfitPrice` 下发（OKX 原生 `oco` 算法单，Binance Spot 使用原子 order-list endpoint）；Binance Spot buy OCO 当前明确拒绝，其他交易所不支持时以明确错误拒绝。预检与风险预留使用 `riskNotional`：buy 取两条腿价格的较高值，另行报告当前价计算的 `observedNotional`，避免低估最坏敞口。

## 13.7 后台监控与仓位守护

交互模式注册 monitor 扩展，按 `monitor.intervalSec`（默认 30s）轮询 `getOpenOrders`（paper 下轮询本身驱动懒撮合）：

- **成交监控**：对比前后两次 open 集合，消失的订单经 `getOrderHistory` 分类，确认成交后注入 `[order monitor]` 消息（custom message，`wakeAgent: true` 时 `triggerTurn` 唤醒 agent），agent 被引导核实持仓并决定后续动作（如入场后补保护单）。
- **仓位守护**（`guardPositions`，默认开）：每次轮询检查 `getPositions`：
  - **裸仓**：持仓没有任何减仓方向的止损类挂单（类型含 `stop`，含 OCO 止损腿；纯止盈单不算保护），且持续超过一个轮询周期宽限期 → 告警，要求 agent 立即设置保护或向用户说明理由。保护出现后宽限期重置。
  - **浮亏**：`unrealizedPnlPct` 达到 `-alertLossPct`（默认 5%）→ 告警并附现有保护单信息，要求 agent 重新评估（砍仓/收紧止损/说明持有理由）。
  - 同一仓位同类告警受 `alertCooldownSec`（默认 900s）冷却，避免每个轮询周期重复唤醒。
- 会话关闭期间的成交不追溯播报（重启后首轮静默快照），历史可查 `/trades`。`/monitor on|off` 只影响本会话。

## 13.8 实验性 `/trigger`

`@nikopack/ti-triggers` 是无副作用求值器：输入定义、上一状态、事实快照和时间，输出状态迁移，不做 IO、不下单。`ti-trader` 用 `trigger-monitor.ts` 注册 `/trigger add|list|remove|clear`。

- 定义和运行时状态只在当前会话内存中；不是跨会话/跨进程的耐久存储。
- 只读 `marketData.getTicker` 和持仓浮亏。价格事实用 ticker 时间戳；缺失或非法时间戳跳过。求值器将超过五分钟的观测视为 unknown，不触发。
- 动作仅 `notify` 与 `wake_agent`。paper 交互会话可以 follow-up 唤醒；live 与 `--print` 只写入 `[trigger:id]` 消息（live 另发通知），`triggerTurn: false`。该消息是观察，不是交易授权或风控批准；awakened 之后的下单仍走确认与风控。

## 14. 当前边界与路线图

**明确不做的（当前版本）**：WebSocket 行情推送、定时任务、回测、多账户、跨所套利。合约 v1 已覆盖 Paper futures 与 Binance USDⓈ-M live；WebSocket 用户数据流和自动账户模式切换仍不在当前版本范围内。

建议优先级：

1. **事件驱动循环**（高价值）：行情 WebSocket 订阅，让 agent 从"请求驱动"升级为"事件驱动"（当前已有 30s 轮询版监控与仓位守护，见 13.7，以及实验性内存 `/trigger`，见 13.8；WebSocket 化可降低延迟，并需要耐久 trigger 状态）。
2. **定时/自主运行**：cron 包装 `--print`，或包内实现调度循环。
3. **回测模式**：`BacktestExchangeClient` 实现同一接口，喂历史 K 线。
4. **策略 skills**：利用 pi 的 skill 机制把交易策略做成可加载文件（需重新启用 `noSkills` 并补一个受控的内容读取通道）。
5. **合约增强**：完善 Paper futures 资金费率、滑点/部分成交、交易所差异化强平模拟、Binance 用户数据 WebSocket、账户模式查询/切换；live 条件单映射已实现，但具体支持取决于 ccxt 适配器及交易所能力，后续可补算法单历史查询。
