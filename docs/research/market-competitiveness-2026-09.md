# Ti 产品形态市场竞争力（2026-09）

调查日期：2026-09-10。对象：`ti-trader` 当前产品形态（paper-first 加密交易 agent CLI，原生买卖工具，编码工具已移除，人确认实盘）是否有足够市场竞争力，以及下一步该开发什么。

证据优先用第一方：官方文档、GitHub API、npm registry、交易所公告。二手评测只用来确认品类存在，不作为能力证明。

## 结论

**技术形态对，市场竞争力不够。**

Ti 选的是「人确认的交易助手，不是无人值守赚钱服务」（见 `docs/product-readiness-plan.md`）。这个定位在 2026 年仍然正确：公开 LLM 实盘模拟赛里，多数模型赛季不赚钱，且本季 14 个模型没有一个跑赢 Bitcoin（TradeRank，2026-09-10）。

但市场已经不缺「能用自然语言下单的 agent」。缺的是 **拿着交易所 key 时仍然可恢复、能力诚实、且不会顺手读盘/跑 shell 的执行层**。Ti 在这一层有工程积累，却几乎没有分发面：公开仓库 [NIKOPACK/Ti-trader](https://github.com/NIKOPACK/Ti-trader) 只有 1★ / 0 forks，没有 MCP/Skill，npm 安装量在发布日后迅速掉到个位数。对外元数据仍指向不存在的 `NIKOPACK/Ti`（npm `repository`/`homepage`、若干 changelog 链接），搜索和包页会落到 404。

下一步不要做更多交易所、Web 看板或无人值守策略。下一步是：**把现有引擎暴露成现有 coding agent 会安装的 MCP/Skill，修正对外仓库链接，把 Paper 长跑证据做完。** TUI 继续当操作台，不要改成 OpenAlice 那种全能研究桌面，也不要改成 NOFX 那种 Autopilot。

## 当前产品形态（对照基准）

来源：仓库 `README.md` / `README.zh-CN.md`、`packages/trading-agent/DESIGN.md`、`docs/product-readiness-plan.md`、npm `ti-trader@0.2.0`（registry 记录 2026-09-08 发布）。

| 维度 | 现状 |
| --- | --- |
| 形态 | 独立 CLI + TUI。命令 `ti`。默认 paper。live 默认逐单确认 |
| 执行 | 25 个原生交易工具；`buy`/`sell` 是一等工具，不是 shell 包装 |
| 安全切面 | 编码工具全部禁用（`noTools: "builtin"`）；密钥本机 `600` |
| 风控 | 单笔/每日名义额、白名单、持久化开仓暂停、未知提交不重发 |
| 恢复 | 执行记录、启动有界对账、`/recovery` `/audit` `/health` |
| 能力诚实 | `supported` / `unsupported` / `unknown` 分开；除 Paper 与 Binance 离线契约外，其他交易所标 experimental |
| 未做 | 正式回测、cron 无人值守、Web UI、MCP server |
| 发布声明 | 已发布 CLI ≠ 生产验收。七天 Paper 长跑与授权实盘试点仍缺证据 |

npm 下载（api.npmjs.org）：

- 2026-08-08 至 2026-09-06：630 次
- 其中 2026-08-27（首次发布日）515 次，之后单日 0–44
- 2026-09-01 至 2026-09-10：32 次

GitHub 公开仓库是 [NIKOPACK/Ti-trader](https://github.com/NIKOPACK/Ti-trader)（2026-08-27 创建，与 npm 首发同日）。2026-09-10 `gh api`：public、MIT、1 star、0 forks、无 homepage、无 GitHub Releases。近 14 天 traffic：26 views / 7 uniques，197 clones / 69 uniques。开放 issue 5 条，全是 Dependabot。

分发泄漏：已发布的 npm 元数据仍写 `git+https://github.com/NIKOPACK/Ti.git`（registry 与 `packages/trading-agent/package.json` 的 `repository`/`homepage`/`bugs`）。`NIKOPACK/Ti` 对 `gh api` 返回 404。从 npm 点「Repository」会离开真实仓库。

## 2026 年市场怎么长的

交易 agent 已经拆成四层。Ti 目前卡在第 3 层，而用户流量在第 1、2 层。

### 1. 交易所把「agent 能下单」做成官方 MCP/CLI/Skill

这层把 Ti 的「原生买卖工具」从差异化变成标配。

| 产品 | 第一方来源 | 形态 | 要点 |
| --- | --- | --- | --- |
| Kraken CLI | [Kraken 公告 2026-03-11](https://blog.kraken.com/news/industry-news/announcing-the-kraken-cli)、[krakenfx/kraken-cli](https://github.com/krakenfx/kraken-cli)（714★ / 97 forks，2026-09-10） | Rust 单二进制 + `kraken mcp` + 本地 paper | 134 条命令；NDJSON；对接 Claude Code / Codex / Cursor / OpenCode / OpenClaw |
| OKX Agent Trade Kit | [okx.com/en-ae/agent-tradekit](https://www.okx.com/en-ae/agent-tradekit) | `npx skills add okx/agent-skills` + `@okx_ai/okx-trade-cli` + MCP | 现货/合约/期权、OCO、移动止损、网格；`--demo` / `--read-only`；密钥只留本机 |
| Coinbase for Agents | [docs.cdp.coinbase.com/coinbase-cli/overview](https://docs.cdp.coinbase.com/coinbase-cli/overview) | 远程 MCP `https://agents.coinbase.com/mcp`（OAuth）+ `@coinbase/coinbase-cli` | ChatGPT / Grok / Claude / Claude Code 一等接入；组合隔离；preview 后再下单 |
| Binance | [Skills Hub](https://developers.binance.com/en/docs/sdks-tools/integrations/skills-hub)、[Agentic Wallet](https://web3.binance.com/en/dev-docs/products/agentic-wallet/install)、搜索命中的 CEX MCP `https://agent.binance.com/mcp/agentic` | Skill 市场 + 链上 Agentic Wallet + CEX 远程 MCP | Skills 对接 Claude Code / OpenClaw；CEX MCP 声称覆盖 Spot / Margin / Convert / USDⓈ-M / COIN-M，且不必把 API key 放本机 |
| CCXT | [ccxt/.claude/skills](https://github.com/ccxt/ccxt/blob/master/.claude/skills/README.md) | 官方 CLI + MCP skill | 100+ 所；sandbox；文档写明 trading safety rails |

含义：用户已经可以在 Claude Code 里说「买 500 USDT 的 BTC」，不必再装一个专用交易 agent。Ti 如果只作为「另一个会下单的 TUI」，没有独立存在理由。

### 2. 通用 coding agent 成为交易入口

OpenClaw 生态里加密 skill 已经是目录级品类（[openclawai.io/skills/crypto](https://openclawai.io/skills/crypto) 列出 218 个）。Jesse 给 Claude/Cursor 接了官方 MCP，用来写策略、跑回测、显著性检验、Monte Carlo（[docs.jesse.trade](https://docs.jesse.trade/)、[jesse.trade/blog 2026-06-30](https://jesse.trade/blog/news/the-blog-is-back-months-of-jesse-updates-in-one-post)）。NinjaTrader 的 MCP skills 明确：**skill 只提案，人批准才提交**（[NT-NinjaTrader/mcp-skills](https://github.com/NT-NinjaTrader/mcp-skills)）。

分发通道是「给用户已经在用的 agent 加一个 skill」，不是「再教用户装一个新 CLI」。Ti 仓库内对 `mcp` 的搜索为空。

### 3. 专用 AI 交易产品（真正的产品形态对手）

| 产品 | 规模（2026-09-10 GitHub API） | 形态 | 与 Ti 的关系 |
| --- | --- | --- | --- |
| [OpenAlice](https://github.com/TraderAlice/OpenAlice) | 7,016★ / 1,120 forks，2026-02-18 创建 | 桌面 + CLI。**桌面内置 Pi**。研究工作区、定时 Issue、Trading as Git（人审再执行）。交易标 beta | 同一上游 harness 的另一种切法：不删编码工具，把 Pi/Claude Code/Codex 编排进研究 OS |
| [NOFX](https://github.com/NoFxAiOS/nofx) | 12,855★ / 3,045 forks | Web 终端 + Autopilot。模型提案、Go 运行时硬风控。9 所 + Hyperliquid 股票/商品/外汇 perp。公开排行榜 | 反面：无人值守、看板、竞赛。要流量走这条，不要跟它比功能清单 |
| [TradingAgents](https://github.com/TauricResearch/TradingAgents) | 104,199★ / 19,995 forks | 多 agent 研究框架（分析师/交易员/风控），模拟交易所 | 占领「LLM 交易」心智；执行安全不是它的产品 |
| [Clawtrade](https://github.com/Paparusi/Clawtrade) | 33★，2026-03-14 后未更新 | CLI + localhost Web，14 个工具 | 形态接近 Ti，已经停更。说明「工具列表仿 Claude」不够 |

OpenAlice 是最近的产品形态对手。它证明：Pi harness 可以做成公开、带桌面、带研究工作流的交易 OS。Ti 选了相反切法（删掉 `bash`/`read`/`write`），这个切法在 **持有交易所密钥** 时更安全，但目前没有被讲清楚，也没有被分发出去。

### 4. 经典量化 bot 仍然是执行成熟度标杆

| 产品 | Stars（2026-09-10） | 仍然强的地方 |
| --- | --- | --- |
| [Freqtrade](https://github.com/freqtrade/freqtrade) | 54,216 | 回测、Hyperopt、FreqAI、dry-run → live |
| [Hummingbot](https://github.com/hummingbot/hummingbot) | 19,949 | 做市、套利、CEX+DEX |
| [Jesse](https://github.com/jesse-ai/jesse) | 8,442 | 无前瞻偏差回测 + 2026 起官方 MCP |

Ti 的 paper 账本、OCO、移动止损、恢复日志，是在补这一层的「agent 版」。不要幻想用 LLM 循环替代 Freqtrade 的回测纪律。

## 能力对照（只比已证实的）

| | Ti | 交易所 MCP/CLI | OpenAlice | NOFX | Freqtrade/Jesse |
| --- | --- | --- | --- | --- | --- |
| 用户已经在用的入口 | 否（独立 `ti`） | 是（Claude Code 等） | 是（桌面编排已有 agent） | 是（Web） | MCP 正在补 |
| 编码工具与密钥隔离 | 是（工具集裁掉） | 否（跑在能 bash 的 agent 里） | 否（原生 agent 仍有自己的工具） | 运行时硬限制，但是 Autopilot | 策略代码本身就是执行 |
| 崩溃后不重发 | 有执行记录 + 有界对账 | 未在第一方文档里作为产品承诺 | 交易 beta，Trading as Git 是审单，不是崩溃对账 | 未作为主卖点 | 成熟 bot 有自己的幂等 |
| 能力 `unknown` 不装成支持 | 是 | 通常暴露全 API，由模型猜 | 交易 beta 警告 | 多所「已支持」清单 | 有官方测试所列表 |
| Paper 账本 | 本地真实行情撮合，含费/PnL/条件单 | Kraken/OKX 有 demo；深度因所而异 | simulator/paper/testnet | 引导直接 live 小资金 | dry-run 成熟 |
| 回测 | 无 | 无 | AutoQuant 工作区 | 无（靠实盘排行榜） | 核心能力 |
| 公开社区 | [Ti-trader](https://github.com/NIKOPACK/Ti-trader) 1★ / 0 forks | 交易所流量 | 7k★ | 13k★ | 8k–54k★ |

Ti 目前唯一站得住的差异是表里第 2–4 行：**密钥与 shell 隔离、未知不装成已知、崩溃不二次提交。** 第 1 行和第 7 行是现在输的原因。

## 不要去抢的战场

公开 LLM 交易赛（[TradeRank 2026-09-10](https://www.traderank.ai/llm-trading-benchmark)）：8 个完整赛季、56 个模型、2,724 笔、模拟资金 $910K，**只有 39% 的模型-赛季盈利**；本季 14 个模型 **0/14 跑赢 Bitcoin（+23.79%）**。Autopilot 产品用排行榜拉新（NOFX Competition）。Ti 若把自己讲成「更会赚钱的 AI」，会和数据以及仓库自己的 readiness 计划打架。

## 推荐下一步（按顺序，不要并行铺开）

仓库自己的 P0（M1–M4 可恢复执行）已经在工作区落地，M6 的七天 Paper 证据仍缺。市场额外要求的是分发，不是新策略。

### 1. 修正对外链接，用一页讲清楚切法

仓库已经公开，问题是找不到、点错。把 npm / `package.json` / changelog 里的 `NIKOPACK/Ti` 全部改成 `NIKOPACK/Ti-trader`，补 GitHub homepage 和与 npm 对齐的 release tag。README 第一屏只需要三句话：

- 这不是会赚钱的 bot，是人确认的交易助手
- 持有交易所密钥的进程没有 `bash`/`read`/`write`
- 超时不等于没单；重启不会默发第二笔

对照页只写 OpenAlice / Kraken CLI / NOFX / Freqtrade，避免功能清单竞赛。

### 2. 做完 M6 证据，再谈 live

`docs/product-readiness-plan.md` 的门槛仍然对：七天受控 Paper soak，零重复提交、不丢未决记录，然后才允许限额实盘试点。没有这份证据，MCP 只是把未验证的执行面送到 Claude Code 里。

### 3. 出 `ti mcp` + `SKILL.md`（竞争力的主开发项）

这是 2026 年这一品类的安装方式。Kraken / OKX / Coinbase / Binance / Jesse / NinjaTrader 都已经这样发货。

范围要窄：

- stdio MCP，暴露现有 25 个工具 + `check_order` + risk/recovery/health
- live 默认仍是 `confirm`；MCP 宿主里没有 TUI 确认框时，拒绝写操作或强制 `--approval confirm` 的带外通道，不要静默变成 unattended
- Skill 文本只教：paper 先行、预检、未知即停、不要重试 unknown
- 密钥继续只在 Ti 进程内签名，模型看不到

这样 Ti 从「用户必须离开 Claude Code」变成「Claude Code 的安全执行后端」。独立 `ti` TUI 保留给要对账、暂停、看审计的人。

### 4. 把已有 journal 做成「人能复核的决策记录」

OpenAlice 的 Trading as Git 是审单 UX。Ti 已有执行记录和 `/audit`，缺的是用户能打开的「为什么下、预检说了什么、谁确认的」。这比新交易所更能支撑「助手」定位。不要为此重开 `write` 工具（见 `docs/research/agent-memory-patterns.md`）。

### 5. 一条实盘路径的外部验证，而不是第 N 个 experimental 所

能力矩阵已经把「其他 live venues」标成 experimental。优先把 Binance spot 或 USD-M 做到 `externally-verified`，与 MCP 的第一条 live 路径重合。OKX/Bybit 等用户去装官方 Skill 即可。

## 明确不做

- 不做 Web Autopilot / 公开收益榜（NOFX 已占，且与人确认定位冲突）
- 不做全市场回测引擎（Jesse/Freqtrade；以后若要，优先互操作而不是重写）
- 不把 live `/trigger` 升级成自动拉起交易回合（现文档已经禁止）
- 不靠「更多工具数量」对抗交易所 MCP

## 来源

- Ti：本仓库 README、DESIGN、product-readiness-plan；https://www.npmjs.com/package/ti-trader ；https://api.npmjs.org/downloads/point/last-month/ti-trader ；https://registry.npmjs.org/ti-trader
- GitHub API 2026-09-10：`NIKOPACK/Ti-trader`（1★ / 0 forks，public）、`TraderAlice/OpenAlice`、`TauricResearch/TradingAgents`、`freqtrade/freqtrade`、`hummingbot/hummingbot`、`krakenfx/kraken-cli`、`NoFxAiOS/nofx`、`jesse-ai/jesse`、`Paparusi/Clawtrade`。`NIKOPACK/Ti` 仍 404，只作为错误对外链接的证据。
- Kraken：https://blog.kraken.com/news/industry-news/announcing-the-kraken-cli
- OKX：https://www.okx.com/en-ae/agent-tradekit
- Coinbase：https://docs.cdp.coinbase.com/coinbase-cli/overview
- Binance：https://developers.binance.com/en/docs/sdks-tools/integrations/skills-hub ；https://web3.binance.com/en/dev-docs/products/agentic-wallet/install
- Jesse MCP：https://docs.jesse.trade/ ；https://jesse.trade/blog/news/the-blog-is-back-months-of-jesse-updates-in-one-post
- TradeRank：https://www.traderank.ai/llm-trading-benchmark （2026-09-10）
- OpenAlice README：https://github.com/TraderAlice/OpenAlice
- NOFX README：https://github.com/NoFxAiOS/nofx
