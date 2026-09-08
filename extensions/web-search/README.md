# Ti Web Search Extension

这是一个 Ti 扩展包，采用 Pi 扩展包的目录、入口和 `ExtensionAPI` 约定。它同时声明 `ti.extensions` 和 `pi.extensions`，因此可由 Ti 或兼容 Pi 的运行时加载。Ti 在显式 `--extension` 参数中接受扩展包目录，会读取其 manifest；也接受直接传入 `index.ts`/`index.js` 入口。

这是一个可选、只读的公开互联网研究扩展。它不属于 Ti 核心交易工具，不访问交易所凭据，也不会执行下单、撤单或账户修改。扩展通过 Tavily 提供 `web_search`，并保留受限的 `fetch_source` 原文读取工具。

## 使用

Web Search 扩展作为 `ti-trader` 发布包中的独立目录提供。安装 `ti-trader` 后，它位于：

```text
node_modules/ti-trader/dist/web-search/
```

从仓库根目录构建 Ti 后加载扩展包目录：

```bash
npm run build:trading
ti --extension ./extensions/web-search
# 也可以直接指定入口
ti --extension ./extensions/web-search/index.ts
```

发布包中的已编译扩展位于 `node_modules/ti-trader/dist/web-search/`。开发时可以使用根目录源码路径。也可以使用绝对路径或用户自己的扩展文件：

```bash
ti --extension ~/.ti-trader/extensions/my-web-search.ts
```

多个 `--extension` 参数可以重复使用。`--no-extensions` 会禁用用户扩展，但不会禁用命令行显式指定的扩展。

## Ti 与 Pi 兼容性

Ti 专用扩展可在 `package.json` 中使用 `ti.extensions`。为兼容 Pi，可同时声明同内容的 `pi.extensions`；Pi 只读取 `pi` 字段。仅有 `pi.extensions` 的现有 Pi 扩展包也可直接由 Ti 加载。

扩展可以在没有 `TAVILY_API_KEY` 的情况下加载，此时不会向 LLM 注册工具。设置非空的 `TAVILY_API_KEY` 后才会注册 `web_search` 和 `fetch_source`：

```bash
export TAVILY_API_KEY='your-key'
# 可选：自定义兼容 Tavily Search API 的 HTTPS endpoint
export TI_WEB_SEARCH_ENDPOINT='https://api.tavily.com/search'
```

启用后提供两个只读工具：

- `web_search`：参数为 `query`、`maxResults`（1-10，默认 5）、`domains`（最多 10 个域名）和 `recencyDays`（1-3650）。返回 `title`、`url`、`snippet`、`publishedAt`、`source` 及 provider 信息。
- `fetch_source`：用于读取搜索结果或用户指定的公开来源。

Tavily API Key 只通过环境变量读取，不会写入工具结果、错误消息或日志。搜索响应和网页内容都标记为不可信外部数据。搜索 endpoint 必须是 HTTPS 且不能包含凭据或非默认端口。

`fetch_source` 当前只允许以下 HTTPS 主机：

- `binance.com`
- `okx.com`
- `bybit.com`

## 安全限制

- 仅允许 HTTPS 的 443 端口（省略端口也使用 443）。
- 禁止 URL 用户名和密码。
- 主机必须在固定白名单中。
- 请求超时 10 秒。
- 禁止自动重定向。
- 只接受 text、JSON 和 XML 响应。
- 响应最多 256 KiB。
- 内容会标记为不可信外部数据，不能当作系统或交易指令。
- 没有 API key、Cookie 或 Authorization header 配置。

交易所的 ccxt 连接仍属于 Ti 交易核心，不由本扩展接管。扩展包使用 Node 内置 `fetch`，没有引入网络库依赖。响应会通过流逐块读取，并在超过 256 KiB 时立即中止，避免先完整缓冲响应。当前未执行 DNS pinning；因此仍存在受控域名 DNS rebinding 风险，这是部署层需要接受或另行缓解的残余风险。用户可以复制此目录开发自己的扩展，但应保持网络访问与交易操作隔离，并为新增域名、认证方式和写操作增加独立的安全审查。
