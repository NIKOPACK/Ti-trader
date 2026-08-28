# `pi-web-access` 与 `websearch` 扩展调查

调查时间：2026-08-28。范围仅包括 npm、扩展作者源码和 Ti/Pi 源码；未连接部署服务器，也未执行真实搜索 API 压测。

## 结论

- `pi-web-access` 的准确安装对象是 npm 包 [`pi-web-access`](https://www.npmjs.com/package/pi-web-access)，当前版本 `0.26.0`，安装命令为 `pi install npm:pi-web-access`。[包清单](https://github.com/nicobailon/pi-web-access/blob/479e282e01490d498abed8bdf33b98cb5625f796/package.json)
- 用户所说的“websearch 扩展包”**最可能是** npm 包 [`@pi-lab/websearch`](https://www.npmjs.com/package/@pi-lab/websearch)，当前版本 `1.0.4`，因为它的包名和注册工具名都恰好是 `websearch`，作者也明确给出了 `pi install npm:@pi-lab/websearch`。[README](https://github.com/anthod0/pi-lab/blob/cb6d6038589c7114a94e62626410838df0d03450/packages/websearch/README.md)
- [`code-yeongyu/pi-websearch`](https://github.com/code-yeongyu/pi-websearch) 是另一个合理候选，但 npm 上不存在未加作用域的 `pi-websearch` 包；它只能按 Git 仓库安装，例如固定当前提交：`pi install git:github.com/code-yeongyu/pi-websearch@ddf5f5d21de57ee3e80f1a6f96aff21a9dd34662`。[包清单](https://github.com/code-yeongyu/pi-websearch/blob/ddf5f5d21de57ee3e80f1a6f96aff21a9dd34662/package.json)
- 在当前“服务器只有 `TAVILY_API_KEY`、没有 `EXA_API_KEY`”的前提下，`@pi-lab/websearch` 能安装但调用必然报错；其源码明确在缺少 `EXA_API_KEY` 时抛错。因此现在无法对它和 `pi-web-access` 做有效的在线性能比较。[工具实现](https://github.com/anthod0/pi-lab/blob/cb6d6038589c7114a94e62626410838df0d03450/packages/websearch/src/tool.ts)
- 若只比较扩展自身开销，`@pi-lab/websearch` 更轻；若比较现有凭据下的可用性、容错和覆盖面，`pi-web-access` 更好。搜索时延和结果质量主要由所选 provider、请求模式和网络决定，作者没有发布二者的同条件基准，不能据包大小断言真实搜索更快。

## 名称辨析与安装对象

| 名称 | 分发与安装 | 注册工具 | 凭据 | 与 Ti 自带工具的关系 |
| --- | --- | --- | --- | --- |
| `pi-web-access@0.26.0` | `pi install npm:pi-web-access` | 默认 `web_search`、`fetch_content`、`source_check`、`get_search_content` | 可直接用零配置 Exa MCP；也支持 `TAVILY_API_KEY` 等多种 provider | 默认 `web_search` 与 Ti 自带同名；可在 `~/.pi/web-search.json` 用 `toolNames.webSearch` 改名 |
| `@pi-lab/websearch@1.0.4` | `pi install npm:@pi-lab/websearch` | `websearch`（无下划线） | **必须** `EXA_API_KEY` | 与 Ti 的 `web_search` 不同名，可以共存 |
| `code-yeongyu/pi-websearch` | `pi install git:github.com/code-yeongyu/pi-websearch@<commit>` | `web_search` | 默认 DuckDuckGo 无 key；可配置 Tavily、Exa、Brave、OpenAI 等 | 与 Ti 自带 `web_search` 同名，不能在同一 A/B 进程中可靠区分 |
| `pi-websearch-router@0.2.3` | `pi install npm:pi-websearch-router` | `web_search` | 12 个 provider 中至少一个 API key | 属于 Michaelliv 的同名项目，不是 `@pi-lab/websearch`；也与 Ti 同名 |

Pi 官方包文档确认 npm 和 Git 安装语法，并提醒第三方扩展以 Pi 进程权限执行，安装前应审查源码。[Ti/Pi 包文档](../../packages/coding-agent/docs/packages.md)

Ti 聚合扩展工具时采用“同名工具第一次注册者生效”。因此同时自动加载两个 `web_search` 实现不会得到公平对照，加载顺序还会改变实际被调用者。[Ti 扩展运行器](../../packages/coding-agent/src/core/extensions/runner.ts)

## 功能与运行特征

### `pi-web-access`

- 搜索、网页正文提取、GitHub 克隆/API 读取、PDF、YouTube/本地视频分析和交互式 curator 都在一个包内；搜索支持 OpenAI、Tavily、Exa、Brave、SearXNG 等大量 provider 和显式/自动回退。[README](https://github.com/nicobailon/pi-web-access/blob/479e282e01490d498abed8bdf33b98cb5625f796/README.md)
- npm 包为 73 个文件、解包约 `7.61 MB`，有 Readability、Defuddle、DOM/PDF、限流和 HTTP 客户端等运行依赖；这些数字来自 npm registry 的已发布包元数据。[npm registry](https://registry.npmjs.org/pi-web-access/0.26.0)
- 默认搜索工作流是 `summary-review`，会启动 curator 并生成摘要；原始性能对比必须将调用设为 `workflow: "none"`，否则测到的是浏览器交互/摘要模型时间，不是搜索 provider 时延。[工具实现](https://github.com/nicobailon/pi-web-access/blob/479e282e01490d498abed8bdf33b98cb5625f796/index.ts)
- 多 query 按顺序执行；显式 provider 数组或 `provider: "all"` 才会并发请求多个 provider 并去重聚合。[搜索聚合](https://github.com/nicobailon/pi-web-access/blob/479e282e01490d498abed8bdf33b98cb5625f796/gemini-search.ts)
- 网页正文抓取并发上限为 3，直接 HTTP 默认超时 30 秒；Exa 直连/MCP 搜索超时 60 秒。[正文提取](https://github.com/nicobailon/pi-web-access/blob/479e282e01490d498abed8bdf33b98cb5625f796/extract.ts)；[Exa 实现](https://github.com/nicobailon/pi-web-access/blob/479e282e01490d498abed8bdf33b98cb5625f796/exa.ts)
- 有 `TAVILY_API_KEY` 时可立即显式使用 `provider: "tavily"`；没有 Exa key 时也能走作者声明的零配置 Exa MCP，但该公共路径可能有独立限流。

### `@pi-lab/websearch`

- 只注册一个 `websearch` 工具，直接调用 `https://api.exa.ai/search`，返回标题、URL、日期、作者和 highlights；无正文抓取、provider 回退、缓存或摘要步骤。[Exa 实现](https://github.com/anthod0/pi-lab/blob/cb6d6038589c7114a94e62626410838df0d03450/packages/websearch/src/exa.ts)
- 支持 `auto`、`fast`、`instant`、`deep-lite`、`deep` 搜索模式、1–20 条结果、类别/域名/发布时间过滤和 `fresh`。
- npm 包仅 4 个文件、解包约 `13.5 KB`，没有普通 `dependencies`，只有 Ti/Pi 与 TypeBox peer dependencies。[npm registry](https://registry.npmjs.org/@pi-lab/websearch/1.0.4)
- 实现没有为 `fetch` 传入 Ti 的取消信号，也没有内部超时；网络挂起时不如另外两个候选可控。这是可靠性差异，不等同于正常响应下更慢。
- 缺少 `EXA_API_KEY` 会在每次工具调用时明确失败；`TAVILY_API_KEY` 对它没有作用。

### `code-yeongyu/pi-websearch`

- 默认可用 DuckDuckGo HTML，无需 key；也可将现有 `TAVILY_API_KEY` 配为 Tavily provider，并支持优先级、round-robin、fill-first 和串行回退。[README](https://github.com/code-yeongyu/pi-websearch/blob/ddf5f5d21de57ee3e80f1a6f96aff21a9dd34662/README.md)
- provider 默认超时 60 秒，可逐 provider 配置；执行结果记录每次尝试的 `durationMs`，比 `@pi-lab/websearch` 更适合直接观察路由时延。[搜索实现](https://github.com/code-yeongyu/pi-websearch/blob/ddf5f5d21de57ee3e80f1a6f96aff21a9dd34662/src/websearch/search.ts)
- 它注册 `web_search`，与 Ti 自带工具冲突；若选择这个候选，必须在独立 Ti 配置/进程中测试，或先明确禁用 Ti 自带扩展。

## 性能判断与可复现实测

当前只能作以下有证据的判断：

1. **启动/常驻开销**：`@pi-lab/websearch` 最小；`code-yeongyu/pi-websearch` 次之；`pi-web-access` 功能和依赖最多。npm 解包大小分别约 `13.5 KB`（`@pi-lab`）与 `7.61 MB`（`pi-web-access`），但包大小不是 API 搜索时延。
2. **当前可用性**：`pi-web-access` 可用现有 Tavily key；`code-yeongyu/pi-websearch` 也可配置 Tavily；`@pi-lab/websearch` 在取得 Exa key 之前不可用。
3. **单次路径开销**：同一 Exa `/search` 请求下，`@pi-lab/websearch` 是最薄的直连封装；`pi-web-access` 只有在 `workflow: "none"`、单 query、`provider: "exa"`、`includeContent: false` 时才接近同一路径。默认 curator、`/answer` 请求或零配置 MCP 路径都不是同条件比较。
4. **容错和研究吞吐**：`pi-web-access` 能多 provider 并发和抓正文，能力更强但可能增加时间与费用；`@pi-lab/websearch` 单 provider 单请求，失败即失败；`code-yeongyu/pi-websearch` 是串行路由/回退，首选成功时开销低，回退时总时延累加。

取得 `EXA_API_KEY` 后，建议在两个独立 Ti 会话中进行公平测试：

- 固定相同 Exa key、同一区域、同一 query 集、`numResults=10`、`type=auto`，先预热 3 次，再各执行至少 20 次。
- `pi-web-access` 固定 `provider: "exa"`、`workflow: "none"`、`includeContent: false`；使用 `numResults=10` 可确保它走 Exa `/search` 而非默认 5 条时的 `/answer` 路径。
- 记录端到端 P50/P95、失败/限流率、返回字节数、有效 URL 数、重复 URL 数和人工相关性；不要只比较一次 wall-clock。
- 测试 Tavily 时，只能比较 `pi-web-access`、Ti 自带 `web_search` 与 `code-yeongyu/pi-websearch`；`@pi-lab/websearch` 不支持 Tavily。

基于用户措辞，推荐安装对象是 `@pi-lab/websearch`，但应同时明确“缺少 Exa key，暂不能调用或跑分”。若用户实际目标是立即利用现有 Tavily key 做 A/B，则目标应改为 `code-yeongyu/pi-websearch`，且必须隔离它与 Ti 自带的同名 `web_search`。
