# Ti Zhihu Global Search

`ti-zhihu-research` 是一个只读的知乎全网搜索扩展。它调用知乎官方开放平台的 `global_search` 接口，将全网结果作为市场背景、行业观点和风险线索提供给 Ti；不会访问账户，不读取 Cookie，不发布、点赞、关注或执行交易。

## 配置

在 Ti TUI 中使用隐藏输入命令配置 Bearer 凭据：

```text
/zhihu-login
```

密钥保存到 `~/.ti-trader/agent/zhihu-access-secret`，文件权限为 `0600`，保存后立即生效。也可以通过环境变量提供凭据；环境变量优先于文件：

```bash
export ZHIHU_ACCESS_SECRET='your-zhihu-openapi-secret'
ti --extension ./extensions/zhihu-research
```

不要把密钥作为 `/zhihu-login` 的命令参数，也不要写入 `package.json`、源码、命令历史或仓库。仓库内不会保存用户提供的密钥。

## 工具和命令

- `zhihu_global_search`：参数 `query`、`maxResults`（1-20）、可选 `filter`（站点/发布时间高级筛选）和 `searchDB`（`all`/`realtime`/`static`），返回标题、摘要、URL、内容类型、作者、互动数、精选评论、排序分数和权威等级。
- `zhihu_search`：上述工具的兼容别名。
- `/zhihu QUERY`：在 Ti 中快速查看全网搜索前 5 条结果。
- `/zhihu-login`：通过掩码输入保存知乎开放平台 Access Secret。

搜索结果标记为不可信外部数据。它们只能帮助形成研究上下文，不能替代交易所行情、账户状态、风险检查或交易确认。任何交易仍必须使用 Ti 原生交易工具并遵守现有风控。

## 官方 API 边界

默认端点为 `https://developer.zhihu.com/api/v1/content/global_search`，请求使用 `Authorization: Bearer ...`、秒级 `X-Request-Timestamp` 和 `Content-Type: application/json`。`Filter` 支持 `host`、`publish_time` 及 `AND`/`OR` 组合；`SearchDB` 支持 `all`、`realtime`、`static`。扩展只允许 HTTPS 的 `developer.zhihu.com`，拒绝重定向，15 秒超时，响应上限 512 KiB；不会调用知乎站内未公开接口。

若返回 `Authorization failed`，说明当前密钥没有该 OpenAPI 权限、已失效或并非该平台的 access secret，需要在知乎开放平台重新核对应用凭据和接口授权。
