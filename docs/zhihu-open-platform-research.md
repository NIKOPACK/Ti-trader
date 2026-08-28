# 知乎数据开放平台研究（Ti 扩展设计）

> 研究日期：2026-08-28（Asia/Shanghai）。
>
> 资料口径：优先使用知乎官方开发者站点的当前文档接口（`/console/api/v3/docs`）及知乎官方《用户协议》《个人信息保护指引》。文档中的额度、模型授权和服务能力可能按账号或租户变化；接入前应在个人中心再次核对。本文不记录任何 Access Secret/API key。

## 结论先行

知乎目前公开给 Agent 的能力集中在：知乎站内搜索、全网搜索、热榜、知乎直答、当前账号的创作/关注/收藏数据、知识库读写，以及 PDF 解析和 PPT 生成。官方文档目录中没有创建回答、发布文章、点赞、评论、关注或收藏等写操作接口，因此第一版 Ti 扩展应定位为**只读研究与个人知识助手**，不要通过抓取知乎网页或模拟操作补齐“发布”能力。[官方开发者文档](https://developer.zhihu.com/docs) · [当前文档数据接口](https://developer.zhihu.com/console/api/v3/docs)

对本项目最有价值的组合是：

1. `zhihu_search` + `hot_list`：研究市场叙事、热点和社区观点，并保留原始知乎链接。
2. `user_contents` + `user_collections`/`favlists`：把用户自己的创作和收藏变成可检索的研究资料。
3. `knowledge/search`：查询用户已授权的知乎直答知识库，作为个人研究资料层。
4. `zhida`：对上述问题做知乎直答式综合回答；金融结论仍需返回来源并交叉验证。
5. `quota`：在工具调用前显示当日剩余额度，避免把限免额度耗尽后才失败。

## 官方能力目录

| 能力 | HTTP 端点 | 主要输入与上限 | 返回/用途 | 官方依据 |
|---|---|---|---|---|
| 知乎站内搜索 | `GET https://developer.zhihu.com/api/v1/content/zhihu_search` | `Query` 必填；`Count` 默认 10、最大 10，超限会截断 | 问题/回答/文章摘要、链接、作者、赞同/评论数、权威等级、精选评论 | 文档键 `zhihu_search`：[开发者文档](https://developer.zhihu.com/console/api/v3/docs) |
| 全网搜索 | `GET https://developer.zhihu.com/api/v1/content/global_search` | `Query` 必填；`Count` 默认 10、最大 20；`SearchDB=all/realtime/static`；`Filter` 支持 `host`、`publish_time` 及 `AND/OR` | 全网内容摘要、链接、作者、权威等级、精选评论 | 文档键 `global_search`：[开发者文档](https://developer.zhihu.com/console/api/v3/docs) |
| 知乎热榜 | `GET https://developer.zhihu.com/api/v1/content/hot_list` | `Limit` 默认/最大 30；非法值回退 30 | 当前热榜标题、知乎链接、缩略图、摘要；当前仅问题和文章 | 文档键 `hot_list`：[开发者文档](https://developer.zhihu.com/console/api/v3/docs) |
| 知乎直答 | `POST https://developer.zhihu.com/v1/chat/completions` | `model`、`messages` 必填；`stream` 可选；模型为 `zhida-fast-1p5`、`zhida-thinking-1p5`、`zhida-agent` | OpenAI 风格非流式 JSON 或 SSE；仅正式保证 `model/messages/stream` | 文档键 `zhida`：[开发者文档](https://developer.zhihu.com/console/api/v3/docs) |
| 用户创作 | `GET https://developer.zhihu.com/api/v1/user/contents` | `ContentType=all/answer/article/zvideo/pin/question`；分页 `Limit` 默认 20、最大 50；可按 `like_count` 或 `ts` 排序 | 当前账号公开创作的 URL、类型、时间、点赞/评论/收藏数、标题、摘要 | 文档键 `user_contents`：[开发者文档](https://developer.zhihu.com/console/api/v3/docs) |
| 用户关注 | `GET https://developer.zhihu.com/api/v1/user/followees` | 分页 `Limit` 默认 20、最大 50 | 关注用户的昵称、主页、头像、简介、性别标记、粉丝数 | 文档键 `user_followees`：[开发者文档](https://developer.zhihu.com/console/api/v3/docs) |
| 用户近期收藏 | `GET https://developer.zhihu.com/api/v1/user/collections` | `Limit` 默认 20 | 收藏内容摘要、收藏时间、所在收藏夹、作者信息 | 文档键 `user_collections`：[开发者文档](https://developer.zhihu.com/console/api/v3/docs) |
| 收藏夹列表 | `GET https://developer.zhihu.com/api/v1/user/favlists` | `Limit` 默认 20 | 收藏夹 ID/链接/名称/描述/公开状态 | 文档键 `user_favlists`：[开发者文档](https://developer.zhihu.com/console/api/v3/docs) |
| 收藏夹内容 | `GET https://developer.zhihu.com/api/v1/user/favlist_contents` | `FavlistUrlToken` 必填；分页 `Limit` 默认 20、最大 50 | 指定收藏夹中的公开内容及作者 | 文档键 `favlist_contents`：[开发者文档](https://developer.zhihu.com/console/api/v3/docs) |
| 知识库列表 | `GET https://developer.zhihu.com/api/v1/knowledge/bases` | `Scope=all/created/subscribed` | 知识库关系、可见性、内容数、更新时间 | 文档键 `knowledge_bases`：[开发者文档](https://developer.zhihu.com/console/api/v3/docs) |
| 知识库内容列表 | `GET https://developer.zhihu.com/api/v1/knowledge/bases/{KnowledgeBaseID}/items` | 不透明 `Cursor`；`Limit` 1..20 | 文档摘要、类型、原始链接，支持游标分页 | 文档键 `knowledge_base_items`：[开发者文档](https://developer.zhihu.com/console/api/v3/docs) |
| 知识库检索 | `POST https://developer.zhihu.com/api/v1/knowledge/search` | `Query` 必填；`KnowledgeBaseIDs` 与 `RecallScopes` 至少一个非空；`Limit` 1..10 | 按相关性返回文档片段及原始来源；支持 `personal/subscription/public` 召回范围 | 文档键 `knowledge_search`：[开发者文档](https://developer.zhihu.com/console/api/v3/docs) |
| 知识库文件上传 | `POST https://developer.zhihu.com/api/v1/knowledge/files` | multipart；单文件最大 100 MB；支持 PDF、Office、文本、图片、电子书等扩展名 | 同步解析并挂载到默认或指定知识库 | 文档键 `knowledge_file_upload`：[开发者文档](https://developer.zhihu.com/console/api/v3/docs) |
| PDF 解析 | 上传 `POST /resources/v1/files`，建任务 `POST /api/v1/pdf-parse/tasks`，查询 `GET /api/v1/pdf-parse/tasks/{task_id}` | 仅 PDF，最大 100 MB；异步任务；下载链接短期有效 | JSON 解析结果，按页/块返回文本、坐标和图片 Base64 | 文档键 `pdf_parse`：[开发者文档](https://developer.zhihu.com/console/api/v3/docs) |
| PPT 生成 | 创建 `POST /api/v1/ppt-generation/tasks`，查询 `GET /api/v1/ppt-generation/tasks/{task_id}` | 仅知乎回答或专栏文章 URL；`num_pages` 6..21；异步任务 | PPTX 短期下载链接 | 文档键 `ppt_generation`：[开发者文档](https://developer.zhihu.com/console/api/v3/docs) |
| 额度查询 | `GET https://developer.zhihu.com/api/v1/quota` | 可选 `APIIDs`，不传返回全部 | 返回自然日 `TotalQuota/TotalUsed/RemainingQuota` | 文档键 `quota`：[开发者文档](https://developer.zhihu.com/console/api/v3/docs) |

### MCP 和 Skill 形态

官方同时提供可直接给 Agent 使用的 Skill 下载包，以及远程 MCP：

- Skill：`https://developer.zhihu.com/download/zhihu_search_skills.zip`、`global_search_skills.zip`、`hot_list_skills.zip`、`zhida_skills.zip`；官方 CLI Skill 入口为 [`zhihu-cli-skill.zip`](https://developer-cdn.zhihu.com/zhihu-cli/releases/stable/skill/zhihu-cli-skill.zip)。
- 搜索/热榜 MCP 使用 MCP over SSE：
  - `https://developer.zhihu.com/api/mcp/zhihu_search/v1/sse`
  - `https://developer.zhihu.com/api/mcp/global_search/v1/sse`
  - `https://developer.zhihu.com/api/mcp/hot_list/v1/sse`
- 直答 MCP 使用 Streamable HTTP：`POST https://developer.zhihu.com/api/mcp/zhida/v1/stream`。
- MCP 文档明确说明这些服务只提供 tools，不提供 resources/prompts；SSE 模式下先建立连接，服务端通过 `endpoint` 事件返回带 `sessionId` 的 message 地址，`tools/call` 结果通过 SSE 返回，而不是同步 POST 响应。[官方 MCP 文档](https://developer.zhihu.com/console/api/v3/docs)

Ti 当前是 `ExtensionAPI` 扩展运行时，第一版直接调用 REST 比在扩展内实现远程 MCP 客户端更简单、可测试且可控。MCP 可作为后续显式配置的适配器，不应自动发现或运行第三方 server。

## 认证与用户授权

### Access Secret（个人数据开放 API）

官方推荐所有数据接口统一使用：

```http
Authorization: Bearer <your_access_secret>
X-Request-Timestamp: <秒级 Unix 时间戳>
Content-Type: application/json
```

Access Secret 在 [知乎开放平台个人中心](https://developer.zhihu.com/profile) 生成。服务端会校验 Authorization 和时间戳；时间戳必须为 Unix 秒，官方额度文档明确要求与服务端时间相差不超过 10 分钟。Access Secret 用于“自己的 Agent 使用自己的知乎数据”，应只从环境变量或操作系统 Secret Store 读取，不写入扩展配置、日志、错误或工具结果。[官方鉴权文档](https://developer.zhihu.com/console/api/v3/docs) · [官方 CLI 安全说明](https://developer.zhihu.com/console/api/v3/docs)

### OAuth（第三方 Web 应用）

OAuth 与 Access Secret 是两条边界：如果只是调用开放平台通用 API 或读取自己的数据，无需 OAuth；如果应用要集成知乎登录、代表其他用户访问数据，则必须单独申请 OAuth。官方流程为 OAuth 2.0 Authorization Code：

1. 向 `https://openapi.zhihu.com/authorize?redirect_uri={redirect_uri}&app_id={app_id}&response_type=code` 引导用户授权。
2. 回调携带 `authorization_code`。
3. 后端 `POST https://openapi.zhihu.com/access_token`，提交 `app_id`、`app_key`、`grant_type=authorization_code`、`redirect_uri`、`code` 换取 Bearer `access_token`（示例 `expires_in=3600`）。
4. 使用令牌读取授权用户信息；换码和令牌使用必须在后端完成。

申请 OAuth 凭证需邮件联系 `openplatform@zhihu.com`，材料包括应用信息、图标、固定回调地址、申请人信息和所需权限。官方列出的用户权限为邮箱、手机、公开内容（个人创作内容、关注用户列表、公开收藏夹），授权时会向用户二次确认。[官方 OAuth 集成文档](https://developer.zhihu.com/console/api/v3/docs)

用户数据接口支持可选 `X-OAuth-Token`：不传表示当前 Access Secret 所属账号；传入表示查询该 OAuth 凭证对应的已授权用户。没有 OAuth 令牌时不要接受任意用户 ID 来“代查”数据。[官方用户内容/关注/收藏文档](https://developer.zhihu.com/console/api/v3/docs)

## 额度、频率和错误处理

- `quota` 返回的是账号在**自然日**内的动态限免额度；当前文档没有承诺统一的固定数字，也没有公开每个接口的固定 QPS。不能把文档示例中的额度数值当成产品契约。
- 知识库列表、知识库内容列表、知识库检索、知识库文件上传共享 `knowledge` 日额度池；PDF 解析和 PPT 生成共享 `tools` 日额度池。额度查询本身不消耗业务额度。
- 所有主要 API 都声明 `30001` 频率限制；用户数据、PDF/PPT 还声明 `30002` 配额不足。PDF/PPT 另有 `40003` 活跃任务数超限。扩展应把 429/30001、30002 和任务超限作为明确错误返回，并通过 `quota` 展示状态，不做静默降级或重复重试。
- PDF/PPT 创建支持可选 `Idempotency-Key`；同一个 key 与相同请求参数重放返回同一 `task_id`，换参数复用 key 会报 `40001`。上传接口特别说明：超时或取消不代表服务端取消，未知结果不要自动重传；相同文件在前一次同步处理期间会被 `40005` 拦截。
- PDF/PPT 结果下载 URL 有过期时间；解析任务重新查询可以获取新的 URL。扩展不应把短期 URL 当永久缓存链接。

官方依据：[额度查询文档](https://developer.zhihu.com/console/api/v3/docs)、[PDF 解析文档](https://developer.zhihu.com/console/api/v3/docs)、[PPT 生成文档](https://developer.zhihu.com/console/api/v3/docs)。

## 内容发布能力：当前不应实现

截至上述官方文档目录，公开接口只有搜索、读取、检索、上传知识库、异步解析/生成等能力；没有回答/文章创建、编辑、评论、点赞、关注、收藏或删除端点。知乎官方 CLI 的能力表也只列搜索、热榜、直答、自己的创作/关注/收藏、知识库和额度查询，没有发布动作。[官方 CLI 文档](https://developer.zhihu.com/console/api/v3/docs)

不要用未公开的 `www.zhihu.com/api/v4`、Cookie、浏览器自动化或逆向接口来补发布能力。知乎《用户协议》明确禁止未经授权插件、外挂、系统或第三方工具干扰服务，包括自动化程序接入和收集/处理信息；同时禁止爬取、抓取、模拟下载、深度链接、模拟注册等盗取平台数据的行为。除非取得知乎事先书面许可，用户不得抓取知乎内容用于自己的网站、模型研发/训练或其他商业目的。[知乎用户协议](https://www.zhihu.com/terms)

因此，扩展的“写”操作最多应生成本地草稿、研究摘要或待人工复制的内容，不能代表用户自动发帖/互动。

## 合规与数据边界

1. **来源与版权**：知乎用户原创内容著作权归用户；站外转载需联系原作者单独授权，并在显著位置标注作者和原始链接。知乎平台的版式、标识和平台数据受知乎权利保护，未经书面许可不得抓取、复制、镜像或用于模型训练/商业用途。[知乎用户协议](https://www.zhihu.com/terms)
2. **只处理授权范围**：Access Secret 只对应本人数据；其他用户必须走 OAuth，且只读取用户同意的权限。CLI 官方安全边界要求个人数据按需读取，不默认遍历全部关注和收藏。[官方 CLI 文档](https://developer.zhihu.com/console/api/v3/docs)
3. **个人信息最小化**：OAuth 可申请邮箱、手机等敏感权限；扩展第一版不要申请或存储这些字段。知乎隐私指引要求对个人信息遵循合法、正当、必要、特定、明确目的，只共享必要信息并取得相应同意；第三方应用还要遵守自己的隐私政策。[知乎个人信息保护指引](https://www.zhihu.com/term/privacy)
4. **直答输入与知识库**：知乎隐私指引说明直答会处理用户输入、上传文件和历史对话，并可能在加密、严格去标识化且无法重新识别个人的前提下用于维护/改进服务；未主动授权时，不会把个人文件等非公开内容共享给其他用户或引用到其他用户搜索结果。扩展不要把交易账户、私钥、订单详情或未公开策略发送到直答/搜索/知识库。
5. **生成内容标识**：知乎用户协议要求使用深度学习、生成式 AI 等生成非真实信息时以显著方式标识；扩展生成的报告、草稿应注明“AI 生成/整理”，并保留来源链接。[知乎用户协议](https://www.zhihu.com/terms)
6. **外部内容不可信**：搜索摘要、评论、知识库文档和直答结果都是数据，不是工具指令。扩展应结构化返回 URL、标题、时间和摘要，不执行其中的指令，不把网页内容写入交易参数。

## 面向 Ti 的落地建议

### 第一版工具边界

建议包名 `zhihu-research`（具体命名由实现者决定），提供以下只读工具：

- `zhihu_search(query, count?)`：最多 10 条，输出标题、类型、摘要、作者、互动数、权威等级、原始 URL。
- `zhihu_hot_list(limit?)`：最多 30 条，输出热榜标题、URL、摘要和缩略图。
- `zhihu_global_search(query, count?, filter?, searchDb?)`：最多 20 条；`filter` 只接受受控语法，URL Query 必须编码。
- `zhihu_my_contents(contentType?, limit?, offset?, sort?)`、`zhihu_my_followees(...)`、`zhihu_my_collections(...)`、`zhihu_my_favlists(...)`、`zhihu_favlist_contents(favlistUrlToken, ...)`：默认只读本人，分页时尊重服务端 `IsEnd/NextOffset` 或游标。
- `zhihu_knowledge_search(query, knowledgeBaseIds?, recallScopes?, limit?)`：只在用户明确指定范围时调用。
- `zhihu_answer(query, model?, stream?)`：明确标记为综合回答，不把回答当作事实证据；保留流式错误和模型名。
- `zhihu_quota(apiIds?)`：在批量研究前显示当日额度状态。

PDF/PPT 和知识库上传会产生文件处理、额度和隐私风险，建议作为二期、显式确认的工具：上传前展示文件名/大小/目标知识库，成功后只返回任务 ID/来源和短期 URL，不自动遍历或上传本地文件。

### 认证、网络和错误设计

- `ZHIHU_ACCESS_SECRET` 只在进程环境变量或 OS Secret Store 中读取；不要接受工具参数传入 token，不要回显 Authorization 头。
- 每次请求生成当前 `X-Request-Timestamp`；固定 `https://developer.zhihu.com` 为 API 主机，禁止模型传任意 URL、Header 或代理。
- 设置连接/响应超时、响应大小上限和并发上限；错误中只返回 HTTP 状态与官方 Code，不返回 secret 或完整响应头。
- 处理 `30001` 时返回“频率受限，请稍后重试”并带 provider/API 名；不要无上限重试。处理 `30002` 时引导调用 `quota`；不要静默换用另一账号。
- 搜索结果只作为候选证据。若需要正文，必须由单独、受控的来源读取策略处理；不能因为结果 URL 来自知乎就自动允许任意重定向或下载。

### 不做的事情

- 不实现自动发帖、评论、点赞、关注、收藏或删除。
- 不抓取知乎网页、调用未公开 v4 接口、复用浏览器 Cookie 或模拟登录。
- 不把用户提供的 Access Secret 写入仓库、文档、测试快照、日志、错误信息或提交记录。
- 不把知乎内容批量导出成训练集或用于商业再分发；需要此类用途时先取得知乎和原作者的明确授权。

## 仍需上线前实测的问题

- 个人中心中该账号实际显示的每日额度、并发任务数和模型租户授权；官方只定义查询方式和错误码，没有统一固定数值。
- `X-Request-Timestamp` 的时钟偏差边界（额度文档给出不超过 10 分钟）以及各 API 的实际 P95 延迟。
- 搜索返回摘要是否足以支持交易研究；对重要结论必须用原始链接和第二来源交叉核对。
- 知识库文件留存、删除和下载 URL 的实际生命周期；上传前应向用户展示数据去向和目标知识库。
- 发布包的隐私说明、用户同意流程和日志留存策略，尤其是 OAuth 场景下的邮箱/手机等敏感字段。

## 主要官方来源

- [知乎数据开放平台](https://developer.zhihu.com/)
- [官方当前文档数据（v3）](https://developer.zhihu.com/console/api/v3/docs)
- [知乎开放平台个人中心](https://developer.zhihu.com/profile)
- [知乎用户协议](https://www.zhihu.com/terms)
- [知乎个人信息保护指引](https://www.zhihu.com/term/privacy)
- [知乎直答知识库入口](https://zhida.zhihu.com/repositories/square)
