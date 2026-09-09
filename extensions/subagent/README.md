# Ti Subagent

`ti-subagent` 按 Pi 的 subagent example 做成 Ti 扩展：父会话通过 `subagent` 工具把研究任务交给隔离子进程。子进程是 coding-agent，不是嵌套的 `ti`，没有交易所凭证。它可以 `propose_order`，但不会提交；主 agent 必须 `check_order` 再 `buy`/`sell`。Paper/unattended 下主 agent 的工具调用就是通过；live/confirm 下仍要人点确认框。

## 使用

按需加载：设置 `TI_SUBAGENT=1`（或 `true` / `yes`），或 `--extension ./extensions/subagent`。

```bash
TI_SUBAGENT=1 ti
```

工具：`subagent`。

- 单次：`agent` + `task`
- 并行：`tasks`（最多 4 个，并发 2）
- 串行：`chain`，任务文本里的 `{previous}` 替换为上一步输出

内置 agent：`researcher`、`scanner`、`reviewer`。用户 agent 放在 `~/.ti-trader/agent/agents/*.md`。项目 agent 在 `.ti-trader/agents/*.md`，未信任项目必须确认；无 UI 时拒绝执行。模型不能关掉这道确认。子进程始终使用父会话 cwd。

## 安全边界

子进程工具只能是 `calculate_indicators`、`evaluate_strategy`、`screen_markets`、`simulate_rule`、`propose_order` 的子集。`buy` / `sell` / `bash` 会直接失败。`propose_order` 只排队给父会话，不碰到交易所。环境变量只转发运行时必要项；模型认证通过 `PI_CODING_AGENT_DIR`（默认 `~/.ti-trader/agent`）复用，不转发交易所 key。子进程 JSON 输出上限 8 MiB。
