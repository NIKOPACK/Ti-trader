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
ti --autonomous status      # 显式启用的 Paper 自主运行时（需独立配置）
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

交易所：Binance（现货与 USDⓈ-M 覆盖最完整）、OKX、Bybit（后两者 experimental）。语言、模式、市场类型在 `/settings`，写入 `~/.ti-trader/agent/trading.json`。模型认证 `auth.json`，交易所 key `keys.json`（权限 600）。手建的 `keys.json`、知乎密钥文件或 freqtrade 认证文件若 group/other 可读，读取前会收紧为 600。

可选扩展在仓库 `extensions/`，发布时打进 `ti-trader/dist/`。默认只自动加载 `market-lab` 和 `market-chart`（只读，不下单）。其余按环境变量或 `--extension` 加载；`--no-extensions` 关掉用户扩展发现：

- `web-search`：`TAVILY_API_KEY` 非空
- `zhihu-research`：`ZHIHU_ACCESS_SECRET` 非空，或密钥文件有内容。默认 `~/.ti-trader/agent/zhihu-access-secret`，可用 `TI_ZHIHU_ACCESS_SECRET_FILE` 覆盖
- `market-research`：`TI_MARKET_RESEARCH` 为 `1` / `true` / `yes`
- `subagent`：`TI_SUBAGENT` 为 `1` / `true` / `yes`。只读隔离子代理，不能交易
- `freqtrade`：`TI_FREQTRADE_URL` 非空。本机 Freqtrade webserver 回测侧车，不下单；仅 `--extension` 时 URL 才回落到 `http://127.0.0.1:8080`

默认 25 个原生交易工具（行情、账户、预检、买卖、风控）加上 market-lab / market-chart。清单与参数见 [DESIGN.md](DESIGN.md)。交易所连接、规划、风控在 `@nikopack/ti-trading-engine`。

### 专业子代理与历史续接

Unreleased 源码中，`subagent` 支持筛选、技术、事件、衍生品、策略和复核角色，并保留通用 `researcher`。主 agent 先用 `subagent_agents` 查看实际能力，再按需并行委派复杂分析；不强制每个任务跑完全部角色，也不重复注入子代理的完整对话。

新研究传 `agent` + `task`，继续时传返回的 `sessionId` + `task`。`subagent_sessions` 找回当前作用域的会话，`subagent_evidence` 按需读取已保存报告和证据。历史在 `agent/subagents` 持久化，子进程每次结束后退出。交互重启须恢复同一父会话、cwd 和账户；自主运行时跨临时 worker 继续历史。新父会话不会继承其他父会话的研究。

`market_research` 复用同一运行时，通过 `sessionId` + `question` 继续，或 `listSessions: true` 列表发现，但不允许订单提案。两种入口在 Ti 内都使用父会话的同源行情；旧报告不是最新账户事实。存储、预算、工具边界和示例见 [Subagent](../../extensions/subagent/README.md)。

## 远程访问边界

`ti-trader` 当前只提供本机 CLI/TUI 和一次性 print 模式，不提供远程交易 server。工作区中的 `@earendil-works/pi-protocol`、`@earendil-works/pi-client` 与 coding-agent `RemoteSession` 是实验性库组件，没有接入 `ti` 启动链；Pi 的 `--mode rpc` 使用 stdin/stdout JSONL，是另一套本地进程集成协议，不是 CBOR 远程服务。

未来若把 Ti 暴露到 Unix socket 或网络，不能把现有库测试当成生产准入证据。启用前必须设计并审计身份认证、按会话与交易账户授权、TLS 或等价传输保护、租约所有权、交易工具 allowlist、逐单确认语义以及撤销和审计路径。

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
		"alertCooldownSec": 900,
		"protectionCoveragePct": 95
	}
}
```

实盘 API key：`/exchange-login okx` 交互录入，或编辑 `~/.ti-trader/agent/keys.json`（权限 600）。API key 只应授予必要的交易权限，不要授予提现权限；不要将 key、token 或账户敏感信息提交到仓库或贴入 issue。

自主 Paper 不是默认产品。要跑无头循环，须在同一 `TI_DATA_DIR` 配置完整 `risk.account`、`orderApproval: "unattended"` 和 `autonomous.json`，再用 `ti --autonomous` 或 `/autonomous` 控制。自主 live 启动会被拒绝。步骤见 [autonomous-trading.md](../../docs/autonomous-trading.md)。

## 保存计划，明天继续

本节描述当前 **Unreleased 源码**；尚未发布。安装 npm 包不等于已获得这些功能，试用前应确认所用候选包含 `/plan` 与 `/decisions`。模型认证与费用独立于 Paper：无需交易所密钥不等于无需模型账号，也不等于免费推理。

向 Ti 说明：“保存这次研究为计划，写清依据、入场条件、失效条件、复查时间和到期时间；暂时不要交易。”模型通过 `create_plan` 保存草稿；由你在终端启用跟踪：

```text
/plan
/plan list 2
/plan show <计划ID>
/plan show <计划ID> 2
/plan track <计划ID>
/plan review <计划ID>
/plan archive <计划ID>
/plan export <计划ID>
```

第二天、另一个工作目录或新会话使用同一 Ti 数据目录和账户即可继续。每轮只注入不超过 4 KiB 的计划索引；原始依据、新版本、追加笔记和事件时间线由 `read_plan` / `get_plan_review` 按需读取。模型修改产生新草稿，不改写旧理由，也不替换已启用版本；再次执行 `/plan track` 并确认后才启用新版。一个计划的标的不可改变。

支持 `price` / `closed_price` 的 `gt`、`gte`、`lt`、`lte` 比较：入场条件全部满足，失效条件任一满足即失效。时间周期为 `1m`、`5m`、`15m`、`1h`、`4h`、`1d`。价格超过五分钟或无法确认行情源时间即未知；已收盘价最长有效到一个周期加五分钟，并排除尚未收盘的 K 线。观察只在交互会话运行，遵循 `monitor.enabled` / `intervalSec`，不会因计划条件满足而唤醒模型、下单、撤单或平仓。

跟踪还观察当前版本的关联订单变化及同标的账户保护覆盖。保护覆盖复用 `monitor.protectionCoveragePct`，但不把多个不完整止损或 OCO 腿相加来宣称保护完整；缺少数量、方向或触发价时显示未知。账户观测时间是读取完成时间，不冒充交易所事件发生时间。同一轮最多刷新 20 条关联执行，包括挂单及仍在引擎日志中、已成交但费用缺失的订单；游标跨重启轮转，未轮到的记录明确标为待刷新。

事件与待发送通知在同一个计划事务内保存。每个计划成功通知后冷却 60 秒；冷却期间保留历史事件，并合并尚未发送的摘要。失败通知使用同一 ID 重试，30 秒租约、五分钟过期，状态见 `/health` 的“计划”项。归档、启用新版或 Paper 重置取消旧通知。发送后、确认落盘前退出仍可能重复通知，不保证严格只送一次；任何计划通知及重试都不会唤醒模型。原有成交监控和仓位守护的唤醒策略不变。

`check_order`、`buy`、`sell`、`place_oco` 可带 `plan: { id, version, intentId }`。模型应为同一拟议动作保持相同 `intentId`，不能用新 ID 重试结果未知的订单。开仓必须使用当前已启用、未到期、条件明确满足的版本；提交前再次校验。归档不撤销已存在订单，经引擎验证的减仓仍可关联原批准版本。计划关联的 live 订单始终要求逐单确认，即使直接交易配置为 `unattended`。

`/plan review` 对照原始版本、条件时间线、拟议订单、实际数量/订单参数、成交均价与当前持仓；同标的外部仓位不会自动算作该计划。准备时参考价与成交均价的差异包含市场变化，不等于已测得纯执行滑点。只有已归因、终态且数量闭合的现货成交与完整报价币费用，才可计算净报价币现金流；这仍不是策略收益评级。缺失成交、费用或完整平仓证据时结果为 `insufficient_evidence`，不是零收益。

费用证据保留原币种、真实金额、来源及完整性。Paper 使用成交时实际记账费用，重启或修改费率不会重算历史费用；live 只使用订单或精确关联成交返回的费用，保留明确的零费用和负数返佣。旧版单独的 `fee` 数字不再被当作实测证据。基础币或第三方代币费用不自动换算，资金费率、点差与执行滑点也不默认是零。

复盘同时进行有界只读修复：刷新当前跟踪计划后，轮转刷新所查计划的历史版本关联挂单并补归档，每个阶段最多 20 条。若还有待刷新记录，可再次请求复盘；结果未知的执行仍应先查 `/recovery`。归档失败显示 `planEvidence: pending`，订单仍按引擎结果处理，不得重发。`/paper reset` 保留旧研究与执行证据，但废止旧账户周期的计划，须修订并重新确认。

列表、详情和复盘支持分页与中英文界面；长正文以明确标记的片段显示，导出保留全文。操作者页面不会被当作模型消息重新注入。模型通过 `read_plan` 的 `section` 读取 `versions`、`notes`、`events`、`intents`、`executions`；通过 `get_plan_review` 读取 `summary`、`differences`、`executions`、`events`、`gaps`，并按 `nextOffset` 继续。历史分区只读已保存快照，需要更新时先请求 `summary`。

数据保存在 `~/.ti-trader/agent/plans/state.json`（支持 `TI_DATA_DIR`）。同一作用域最多跟踪 20 个计划；总计 500 个计划，每个最多 100 版、200 条笔记、各 1000 条事件/意图/执行快照。容量用尽会明确报错，不静默删除证据。`/plan delete <ID>` 只允许删除已归档且没有执行意图的计划。导出文件权限 600，含敏感账户研究，不要上传或提交。

升级前停止同一数据目录的所有旧写入者，并一起备份整个 `agent` 目录；计划导出不能替代风险、执行和 Paper 账本备份。恢复必须核对原账户及 Paper 原始绝对路径，不可修改账户 ID 来绕过不匹配，也不能把旧备份当作从未下过单。步骤见[备份与恢复](../../docs/trading-operations.md#back-up-state-consistently)。

## 分开看运行、决策纪律与策略表现

Ti 会在本地保存每轮模型/提示词/工具指纹、有限数字观测、公开理由以及实际交易工具调用。`record_decision` 应在交易前记录理由，也允许 `wait`、`hold`、`avoid`；事后理由不会补成事前证据。

```text
/decisions
/decisions list 20
/decisions show <记录ID> 0
/decisions evaluate
/decisions evaluate discipline
/decisions evaluate strategy
/decisions evaluate samples
/decisions evaluate executions
/decisions evaluate protocols
/decisions export
/decisions delete <记录ID>
```

命令不调用模型，操作者页面不会重新注入模型消息。`list`、`show` 和评估分区每次最多 20 条、条目预算 16 KiB；按返回的 `nextOffset` 继续，不把它当页码。模型工具 `get_decision_evaluation` 默认只返回概览，通过 `section` 和 `offset` 读取详细分区；不会把全部样本塞进上下文。

纪律评估按账户、Paper 周期、模型和指纹分组，报告样本数、引用缺失/过期、无来源时间、遗漏理由、事后说明、风控阻断及未知结果；缺失记录、采集故障和未完成回合不能判通过。只保存白名单数字快照，不保存原始提示词、完整对话、模型隐藏推理、凭证或原始错误。模型自己写的理由仍是声明，不是事实。

### 先固定协议，再观察未来结果

在 `spot` 作用域中，由操作者确认协议；不能让模型看完结果再选择观察期限或成本：

```text
/decisions study create {"name":"spot-1h","symbols":["BTC/USDT"],"horizonSeconds":3600,"maxSourceAgeSeconds":60,"endpointWindowSeconds":60,"feeBpsPerSide":10,"slippageBpsPerSide":5,"minimumSamples":20}
/decisions study
/decisions collect
/decisions study stop <研究ID>
```

这是格式示例，不是成本估计或参数推荐。`horizonSeconds` 固定观察期限，`endpointWindowSeconds` 是到期后的采集窗口；`maxSourceAgeSeconds` 限制来源时间年龄。费用和滑点单位为基点（1 bp = 0.01%），每边分别计入。每个作用域最多一个正在接收新样本的协议；修改要先停止旧协议，再确认新协议，旧样本仍按原协议处理。

只有确认后的新回合入组。决策必须引用交易前读取的、作用域与标的一致、无缺失警告的 `get_price` 观测；`sourceTimestampKnown: true` 才能证明时间来自行情源，而非本地时钟补值。公开预测使用 `forecast.direction: "up" | "down" | "flat"`，不从自由文本猜方向；自由文本 `horizon` 不改变协议期限。

会话运行时每五秒尝试采集，每轮最多检查 100 个待处理样本、读取 20 个去重标的，单个行情请求最多等待十秒。当前有效窗口优先于过期积压；共享同次报价的样本按真实接收时间成批落盘，过期结果也成批保存，避免每个样本重写整个文件。窗口内首个有效报价一经保存即固定。退出后不采集；重启可继续尚未过期的窗口，错过窗口保留缺失，不补历史价格。`study stop` 只停止后续入组，已入组样本继续只读观察。Paper 重置废止旧周期的待观察样本，新周期须重新确认协议。这些采集不唤醒模型、不执行订单，也不继承 `monitor.enabled` 的计划监控开关。

现货 `enter` 且明确预测上涨按单位资金做多计算；`wait` / `avoid` 按持有报价币计算。每条同时给出持币和买入持有基准，以及声明双边费用/滑点后的差值。结果按作用域、周期、模型、指纹、协议、动作和标的分组；小样本、重叠样本或缺失结果保持 `insufficient_evidence`。只有完整且非重叠样本达到预设门槛，才标 `descriptive_evidence_only`（仅描述性证据），不是统计显著性或模型信任评级。单位资金收益的均值不是账户资金曲线；做多与同窗口买入持有采用相同规则，不能用二者相等宣称超额收益。

`hold` / `reduce` / `exit` 缺可归因起始仓位，以及合约缺资金费、杠杆和强平资料时不计算此对照。实际执行分区另读引擎记录和永久计划档案，按执行 ID 对应事前理由，展示真实成交与报价币费用；缺少闭合买卖批次归属时，已实现收益仍为 `null`。可证明闭合的计划现金流请查看 `/plan review`，不能与假设成本的前瞻对照混用。

`decisions/state.json` 最多保存 1000 个回合、100 个协议及 30000 个结果；每回合最多 100 个观测、100 个操作及 30 条理由，文件上限 32 MiB。容量用尽明确报错，不自动删除样本。仅未入组且已结束的记录可通过 `delete` 删除；已入组记录不可选择性删除，以免只保留好结果。长研究须提前考虑容量，导出不是清空或重置账户的授权。

私密导出包含完整冻结证据、协议、结果、已留存的最新执行事实和有界评估概览，不重复保存全部派生行，最大 128 MiB；单文件导出不替代整个账户备份。库导出的 `validateDecisionEvidence` / `evaluateDecisions` 可对导出文件的 `evidence` 字段离线重算纪律与前瞻对照；`evaluateActualExecutions` 使用 `evidence`、`executionRecords` 和 `Date.parse(evaluatedAt)` 重算该时点的实际执行报告。记录范围仍是交互/单次会话，不包括独立自主 Paper 守护进程。

三种结论不可互相替代：运行就绪依赖实际长时间 Paper、恢复及独立安装证据；纪律评估只说明可观察行为；前瞻对照只描述固定规则下的结果。`no_recorded_discipline_issues` 或 `descriptive_evidence_only` 均不表示模型可信、策略盈利或获准实盘。

## 工具结果与订单状态

输入区上方统一显示交易模式、交易所、审批策略和监控健康。开仓阻断或监控异常优先显示；存在未决执行时会提示 `/recovery`。观测时间表示上次实际观测距今多久，不是界面刷新时间。状态区每五秒刷新本地状态，不查询交易所；“开仓阻断：无”不代表下单授权。

原生交易工具默认显示紧凑摘要，警告、预检阻断和未知订单状态不会随原始结果折叠。使用工具展开快捷键（默认 `Ctrl+O`，可自定义）查看请求参数和完整原始输出。界面摘要不改变返回给模型的结果，也不会额外查询交易所。

预检通过不代表已经提交订单；挂单不代表成交。订单结果分别显示挂单、部分成交、成交、撤销、拒绝或未知状态，并保留执行编号和订单编号。数据不可用时不会显示为零。提交结果未知时，先查看 `/recovery`，不要重复下单；停止 Agent 不会撤销已经提交的订单。

实盘采用逐单确认时，TUI 会按字段展示引擎实际准备的订单：交易所与账户指纹、方向、数量、价格条件、名义金额、已用及预占额度、价格来源与观测时间。确认页默认选中“取消，不提交”，支持中文换行和翻页（默认 `PageUp` / `PageDown`，可自定义）；终端过小时仍可滚动和取消，但须放大后才能提交。RPC 沿用原有确认协议，接收同一份结构化复核内容。

确认不绕过引擎的最终余额、额度及交易所约束检查。实盘手续费和最终支出仍可能未知；买入 OCO 的风险名义金额也不是保证支出上限。Paper 与无人值守实盘的审批策略不变。

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

`/monitor` 查看状态，`/monitor on|off` 开关本次会话的监控。`/paper reset [金额]` 重置模拟账户。`/autonomous` 控制显式启用的 Paper 自主运行时，不替代交互会话。

未配置 `risk.account` 时，live 的 `cancel_order` / `cancel_order_list` 会拒绝撤销仍保护开仓的止损类挂单；应保留保护或走受控平仓。配置了账户硬风控后，由硬风控仲裁撤单。

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

默认工具使用统一的 `get_positions` 和 `get_contract_stats`/`get_funding_rate_history`。买卖工具额外支持 `reduceOnly`、`positionSide`、`stopPrice`、`closePosition`。agent-facing 的 futures `amount` 永远是 base 数量，交易所提交数量及 amount limits 是 contracts，必须使用市场报告的 `contractSize` 转换；缺失、非线性或无法精确表示的合约元数据会拒绝下单，绝不按 1 猜。订单和持仓返回值会从 contracts 转回 base。

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
  args.ts               CLI 参数（--mode/--exchange/--print/--autonomous）
  config.ts / state.ts  配置与状态持久化（~/.ti-trader/agent/）；密钥读取时收紧 600
  context.ts            交易运行时单例：marketData、tradingEngine、配置和模式切换
  tools/index.ts         25 个原生交易工具（行情读取与交易引擎编排）
  autonomous/            显式启用的 Paper 自主运行时（live 启动 fail-closed）
  monitor.ts              后台成交监控 + 仓位守护（裸仓/浮亏告警，唤醒 agent）
  trigger-monitor.ts      实验性 /trigger：持久化条件与状态；live 只通知
  monitoring-state.ts     账户作用域、监控状态、通知队列和健康快照
  plans/                  私密版本化计划、只读跟踪、关联档案与分页复盘
  decisions/              公开决策理由、观测证据和分组评估
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
