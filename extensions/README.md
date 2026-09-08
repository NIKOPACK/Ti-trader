# Ti 扩展包

此目录存放 Ti 扩展源码模块。对外可安装的 Pi Package 是 `ti-trader`；发布构建会把这些模块复制到 `ti-trader/dist/`，并生成对应的 JavaScript 扩展清单。五个扩展都会随发布包一起打进 `dist/`。

## 默认加载与按需加载

`ti-trader` 默认只自动加载：

- `market-lab`：`calculate_indicators`、`evaluate_strategy`、`screen_markets`、`simulate_rule`，以及 `/indicators` `/signal` `/screen` `/replay`
- `market-chart`：`show_market_view`，以及 `/chart`

以下三个扩展仍打进 `dist/`，但只在条件满足或 `--extension` 时加载：

- `web-search`：环境变量 `TAVILY_API_KEY` 去空白后非空，或 `--extension`
- `zhihu-research`：环境变量 `ZHIHU_ACCESS_SECRET` 去空白后非空，或默认密钥文件 `~/.ti-trader/agent/zhihu-access-secret`（可用 `TI_ZHIHU_ACCESS_SECRET_FILE` 覆盖）存在且含非空白内容，或 `--extension`
- `market-research`：`TI_MARKET_RESEARCH` 为 `1` / `true` / `yes`（去空白、不区分大小写），或 `--extension`

默认 LLM 工具为 25 个原生交易工具 + 4 个 lab 工具 + `show_market_view`。

清单兼容规则：

- Ti 按资源字段优先读取 `ti` 清单，字段缺失时回退到 `pi` 清单；默认 Pi 加载器仍只读取 `pi`。
- `extensions` 是相对于包目录的入口文件数组。
- 源码清单只声明 `./index.ts`；发布构建生成只声明 `./index.js` 的清单，避免重复注册同一扩展。
- 没有清单时，目录中的 `index.ts` 或 `index.js` 仍可作为入口。
- 现有 Pi 扩展包可以直接通过 `--extension` 加载；Ti 扩展同时提供 `pi` 字段以兼容 Pi。

每个扩展包应使用独立子目录，例如：

```text
extensions/
  market-lab/
  market-chart/
  market-research/
  web-search/
  zhihu-research/
```

扩展包可以复用 Pi Extension API，并通过 Ti 提供的交易上下文访问行情、账户和受控交易能力。扩展不得绕过 Ti 的风控和实盘确认流程。

`zhihu-research` 是只读的知乎全网搜索扩展，使用官方 `global_search` API 为交易研究提供外部背景资料。它不读取 Cookie，不调用未公开站内接口，也没有任何交易或内容发布路径。
