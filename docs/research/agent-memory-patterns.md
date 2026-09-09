# Agent 长程记忆做法调查

调查时间：2026-09-09。范围：各家官方文档、工程博客与公开源码。问题：agent 如何在**不把模型变成任意写盘的 coding agent** 的前提下，保存跨会话思路、偏好与进度。

未覆盖：第三方 Mem0 / Supermemory 插件（它们是外挂，不是产品自己的切法）。未找到公开、可引用的生产级 LLM 交易 agent 笔记本实现。

## 结论

行业已经收敛成**两层**，没有人用「开放 `write`/`bash`」来解决长程思路丢失：

1. **人写的站岗指令**（always-on）：`AGENTS.md` / `CLAUDE.md` / `GEMINI.md` / Rules。这是行为约束，不是模型自己的日记。
2. **模型写的工作记忆**（独立通道）：专用 memory 工具、旁路抽取、或受限目录。即使产品已经有完整文件写权限，也另开这一层，避免笔记和产品文件混在一起。

对 Ti 直接可用的共识：

- 工作面（下单）和笔记本（thesis）必须分工具。coding agent 的 `write` 对应 Ti 的 `buy`/`sell`，不是对应笔记。
- 每轮只注入**短索引**（Claude Code：`MEMORY.md` 前 200 行或 25KB；Letta：core memory 块有字符上限）。细节按 id 再读。
- 模型参数里不要给真实路径；若用文件隐喻，必须锁在虚拟前缀（Anthropic：`/memories`）。
- 笔记不是权威状态。Copilot 用代码 citation 再验证；Ti 应对持仓/订单再验证。
- 人必须能看、改、删（`/memory`、Settings、仓库设置）。

## 对照

| 产品 | 站岗指令（人） | 模型自己写的记忆 | 写入口 | 注入策略 | 沙盒/配额 | 与代码 write 的关系 |
|---|---|---|---|---|---|---|
| Claude Code | `CLAUDE.md` 层级 | Auto memory：`~/.claude/projects/<repo>/memory/` | 模型写 markdown；`/memory` 开关 | 每会话加载 `MEMORY.md` 前 200 行或 25KB；topic 文件按需读 | 超限仍写入但下次截断；不进 git | 有完整 write，记忆仍单独目录 |
| Anthropic API Memory | 调用方 system prompt | 客户端 `/memories` 虚拟目录 | 专用 `memory` 工具（view/create/str_replace/insert/delete/rename） | 工具描述强制先 `view /memories`；按需读文件 | 必须拒绝 `../`；调用方限额 | 与 text editor / bash **分开** |
| Codex CLI | `AGENTS.md` | `~/.codex/memories/` 生成态 | 后台抽取+合并，不鼓励手改 | `memories.use_memories` 控制是否注入 | 跳过短会话；脱敏 secret；默认关 | 有 write，记忆是生成文件不是 cwd |
| ChatGPT | 用户可编辑记忆 | 聊天抽取的 topic 记忆 | 产品侧，非文件系统 | 新对话带入 | Settings 开关；用户可删 | 无本地 write |
| Cursor | Rules / `AGENTS.md` | 项目级 Memories | sidecar 抽取（保存前确认）+ agent `update_memory` 类工具 | 认为相关时带入 | 个人、不进 git | 有 write，记忆不进仓库 |
| Windsurf Cascade | Rules / `AGENTS.md` | `~/.codeium/windsurf/memories/` | 自动生成或「create a memory of …」 | 相关时检索；工作区隔离 | 不进仓库；不耗额度 | 有 write，记忆本机 |
| Gemini CLI | `GEMINI.md` 层级 | 全局 `~/.gemini/GEMINI.md` + 项目私有 memory 目录 | 早期 `save_memory(fact)`；现文档改为编辑 md。Auto Memory 只写 **inbox patch**，批准后才改正式文件 | 层级 context 自动加载 | Auto Memory 不能直接改项目 `GEMINI.md`、设置、凭证 | 有 write，但记忆路径被路由 |
| Cline / Roo | 自定义 instructions | 仓库内 `memory-bank/*.md` | **复用普通 write**，靠 prompt 纪律 | 每任务开始读完全套文件 | 无运行时沙盒 | 这是「用 write 当记忆」，Ti 不可用 |
| Goose | `.goosehints` | `.goose/memory/` 或 `~/.config/goose/memory/` | 专用 `remember_memory` / `retrieve_memories` | **会话开始全部注入** | 分类+local/global；无路径参数 | 与 developer 扩展分开 |
| Letta / MemGPT | system + 人设块 | core memory 块 + archival 向量库 | `memory_replace`/`insert`/`rethink`；`archival_memory_insert`/`search` | core **始终在 prompt**；archival 按需搜 | core 块有字符上限（文档示例 2k） | 无任意文件系统 |
| LangGraph | 应用自己定 | Store（跨 thread KV）+ Checkpointer（单 thread） | 节点/工具读写 store | 应用决定注入 | namespace 隔离 | Deep Agents 把 `/memories/` 路由到持久 Store，其余是临时盘 |
| CrewAI | agent backstory | 统一 `Memory.remember` / `recall` | 任务后自动抽事实；也可显式 remember | 任务前 recall 注入 | scope 树；private+source | 无代码 write |
| GitHub Copilot | `.github/copilot-instructions.md` | 托管 Memory | 后台捕获，人不可当日记写 | 检索最近条目，用前对照当前代码 citation | 28 天未用过期；校验失败不用 | 无本地任意写 |
| Amp | `AGENTS.md` | 无独立 agent 笔记本（文档只覆盖指令文件） | 人/agent 更新 AGENTS.md | 启动加载 | 层级加载 | 有 write |
| Aider | `--read CONVENTIONS.md` | **无**跨会话模型日记（issue #5371 仍在要） | 无 | 只读 conventions | 只读标记 + prompt cache | 有 edit，记忆未产品化 |
| OpenHands | `AGENTS.md` / microagents | 会话 event 持久化，不是独立笔记 | 恢复整段对话 | 恢复 thread | conversation id | 有 write；跨会话靠 resume，不靠笔记本 |
| Continue.dev | rules | 产品无内建跨会话记忆 | 社区用 MCP | — | — | 有 write |

## 各家做法（一手）

### 1. Claude Code：指令文件 + 机器本地 auto memory

官方把两套分开：`CLAUDE.md` 是人写的规则；auto memory 是 Claude 给自己写的 learnings。后者按 git repo 存在 `~/.claude/projects/<project>/memory/`，含 `MEMORY.md` 索引和 topic 文件。每会话只加载索引前 200 行或 25KB；超限写入仍成功，但运行时要求模型改写索引，因为超出部分下次会被丢掉。topic 文件不启动加载，用普通读工具按需打开。不进 git、不跨机器。可跳过能从代码推出来的内容。`/compact` 后会重读项目根 `CLAUDE.md`。

来源：[How Claude remembers your project](https://code.claude.com/docs/en/memory)

对 Ti：这是最接近「短索引 always-on + 正文按需」的产品实现。

### 2. Anthropic Memory tool：虚拟文件系统，不是真实 write

`tools: [{ type: "memory_20250818", name: "memory" }]`。模型只发 `view/create/str_replace/insert/delete/rename`，**应用侧**映射到自己的存储。路径必须落在 `/memories`；文档把 `../` 路径穿越写成必须由实现拒绝。系统会自动加协议：先 view 记忆目录，边做边记，因为上下文随时可能被打断。可与 compaction 并用：摘要管对话，memory 管必须活过摘要的事实。长程软件项目的推荐形态是 initializer 写进度文件 + 后续会话先读再增量，而不是把整段历史塞进窗口。

来源：[Memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)；[Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

对 Ti：若需要文件隐喻，只暴露 `/notebook` 前缀，handler 锁死真实目录。命令集可以更窄（upsert/list/read/archive），不必做成完整编辑器。

### 3. Codex：AGENTS.md 是规则，memories 是生成态

官方明确：团队必须遵守的规则放 `AGENTS.md`；memories 只是 recall 层，不能当唯一规则源。本地记忆默认关，在 `~/.codex/memories/`。后台等会话空闲后再抽取，跳过过短/仍在进行的会话，对生成字段做 secret 脱敏。文档要求把这些文件当 generated state，不要当主控制面手改。ChatGPT web 记忆与 Codex 本地记忆是两套。

来源：[Memories](https://learn.chatgpt.com/docs/customization/memories)；[Customization overview](https://learn.chatgpt.com/docs/customization/overview)

对 Ti：执行 journal / 风控状态已经是 generated+权威；thesis 笔记本应是另一份 generated+可审计，不要让模型手改 `trading-state.json`。

### 4. Cursor / Windsurf：旁路抽取 + 专用记忆，不进仓库

Cursor 官方（多语言 docs 一致）：Memories 由 sidecar 模型从 Chat 抽取，**保存前要用户确认**；agent 也可以用工具直接建记忆。项目作用域，Settings → Rules 管理。社区记录过 `update_memory` 工具名。

Windsurf：自动记忆存 `~/.codeium/windsurf/memories/`，按工作区隔离、不 commit。团队要共享的内容应写成 Rule 或 `AGENTS.md`。相关时检索，不全量灌进 prompt。

来源：[Cursor Memories（中文文档）](https://docs.cursor.com/zh/context/memories)；[Cascade Memories](https://docs.windsurf.com/windsurf/cascade/memories)

对 Ti：sidecar 确认适合「用户偏好」；交易 thesis 更适合模型显式 `notebook_write`，成功以 tool result 为准。

### 5. Gemini CLI：路由到指定 md，Auto Memory 不能直写正式文件

当前文档：记忆通过编辑 Markdown 持久化，按层路由到仓库 `GEMINI.md`、项目私有目录、或 `~/.gemini/GEMINI.md`。早期实现是专用 `save_memory(fact)`，只追加到用户主目录 `GEMINI.md` 的 `## Gemini Added Memories`。Auto Memory 只扫描**已空闲 ≥3 小时**的旧会话，产出可审查的 `.patch`；明确不能直接改活跃记忆文件、settings、凭证或项目 `GEMINI.md`。

来源：[Memory files](https://geminicli.com/docs/tools/memory/)；[Auto Memory](https://geminicli.com/docs/cli/auto-memory/)；[save_memory 源码文档](https://google-gemini.github.io/gemini-cli/docs/tools/memory.md)

对 Ti：即使借用文件，也要「专用工具 + 允许列表路径」。Auto Memory 的 inbox 审批对交易 thesis 过重，但「不能直写配置/凭证」这条要保留。

### 6. Goose：最像 Ti 该做的专用工具

内置 Memory 扩展。工具是 `remember_memory(category, data, tags, is_global)` 等，**没有路径参数**。落盘到 `.goose/memory/` 或 `~/.config/goose/memory/`。会话开始把已存记忆全部放进 prompt。与 `.goosehints`（人写指令）分开。

来源：[Memory Extension](https://goose-docs.ai/docs/mcp/memory-mcp)

对 Ti：工具形状最接近推荐方案。Ti 不应「会话开始全量注入」——Goose 面向短偏好；交易笔记会长，必须走索引+按需读。

### 7. Letta / MemGPT：core 常驻，archival 外置

这是论文级分层：in-context core memory（人设、用户、工作块，模型用工具自改）+ out-of-context archival（向量库，insert/search）+ recall（搜旧对话）。core 始终可见，所以有硬配额。archival 不钉在窗口里。

来源：[Letta memory](https://docs.letta.com/guides/agents/memory)；[MemGPT architecture](https://docs.letta.com/guides/agents/architectures/memgpt/)

对 Ti：open thesis / 站岗规则 = core；复盘 / 已归档 = archival。这是正确的深度模块切法。

### 8. LangGraph / CrewAI：应用拥有的 store，不是模型拥有的磁盘

LangGraph：Checkpointer = 单 thread 短记忆；Store = 跨 thread 的 namespace+key JSON。Deep Agents 默认文件系统是 thread 内临时的；把 `/memories/` 路由到 Store 才跨会话。

CrewAI：`Memory.remember` / `recall`，scope 像文件系统路径但由库实现；任务后自动抽原子事实；private+source 做隔离。默认 LanceDB 在 `./.crewai/memory`。

来源：[LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence)；[Deep Agents long-term memory](https://docs.langchain.com/oss/python/deepagents/long-term-memory)；[CrewAI Memory](https://docs.crewai.com/en/concepts/memory)

对 Ti：不要引入向量库做第一版。交易笔记需要人可读、可备份、可进现有 `agent/` 目录。KV/JSON 足够。

### 9. Copilot Memory：托管 + citation 校验 + 过期

仓库级事实带代码 citation，用之前对照当前分支；对不上就不用。用户偏好只回该用户。28 天不用即删，用过且校验通过可续命。仓库 owner 可审可删。跨 coding agent / review / CLI 共享。

来源：[About GitHub Copilot Memory](https://docs.github.com/en/copilot/concepts/agents/copilot-memory)；[工程博客](https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/)

对 Ti：「用之前对照权威源」应映射为：读笔记后必须再 `get_portfolio_snapshot` / `get_positions`，笔记不能当成交或风控证据。过期策略可后做；先标 `updatedAt` 和账户身份。

### 10. Cline Memory Bank / Aider / Amp / OpenHands：边界样本

- **Cline**：六份仓库内 markdown，靠「每任务必须先读完」的 prompt。这是在**已有 write** 的 coding agent 上加约定，没有运行时路径锁。Ti 已关掉 write，不能抄。
- **Aider**：`CONVENTIONS.md` 只读注入；跨会话模型日记仍是功能请求。
- **Amp**：只把 `AGENTS.md` 当指令，没有独立 agent 笔记本。
- **OpenHands**：持久化的是 conversation events，跨会话靠 resume，不是「写下 thesis 供 `/new` 使用」。

来源：[Cline Memory Bank](https://docs.cline.bot/best-practices/memory-bank)；[Aider conventions](https://github.com/Aider-AI/aider/blob/main/aider/website/docs/usage/conventions.md)；[Amp AGENTS.md](https://ampcode.com/docs/customize/agents-md)；[OpenHands persistence](https://docs.openhands.dev/sdk/guides/convo-persistence)

### 11. Anthropic 长程 harness：进度文件，不是更大的 context

跨很多窗口时，compaction 不够。失败模式是：一次做太多、半成品无文档、后一班宣称完工。解法是 initializer 写下 feature list + `claude-progress.txt` + git；后续会话先读进度和 git，只做一项，结束时提交并更新进度。权威清单用 JSON，因为模型更不容易胡改。

来源：[Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

对 Ti：open thesis 就是 feature list；「一次一项、结束时把失效位写回笔记本」比「把整段会话摘要当记忆」可靠。不要让模型改执行 journal 来当进度条。

## 对 Ti 的映射

| 别人的层 | Ti 已有 | 还缺 |
|---|---|---|
| 人写的 AGENTS.md / Rules | 系统提示词 + 风控配置（人改 `trading.json`） | 不要打开 `noContextFiles` 去读仓库 md |
| 会话 transcript / compact | pi session + `/compact` | compact 后 thesis 丢失，这正是缺口 |
| 权威状态 | 持仓、订单、execution journal、paper ledger | 不要让模型往这里写散文 |
| 模型工作记忆 | 无 | **notebook**：短索引注入 + 按 id 读写 |
| 校验 | 下单前 `check_order` | 用笔记前再读账户，笔记标 stale |

不需要抄的：Cline 式仓库 write、Gemini 早期「用通用 `write_file` 改记忆」、CrewAI/MemGPT 向量库第一版、Copilot 托管服务。

需要抄的最小集合：Goose 的无路径专用工具 + Claude Code 的索引配额 + Letta 的 core/archival 分层 + Copilot 的「用前对照权威源」+ Anthropic 的「一次一项并写回进度」。
