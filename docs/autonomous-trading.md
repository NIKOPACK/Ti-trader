# Autonomous Paper trading

Ti has an explicitly enabled, headless Paper runtime (working tree; not in the last npm release). The model chooses its research, strategy, instruments, trades, position management and next wake. Waiting and holding cash are valid decisions. There is no prescribed analysis sequence, vote, score or minimum trading frequency.

**Autonomous live startup is currently rejected.** Existing live adapters do not supply the complete external-capital-flow, fee and funding evidence required by account-wide hard risk. Setting `mode: "live"` does not bypass this check or fall back to Paper. This implementation is not a claim of profitable trading or production readiness.

The existing interactive command and its defaults are unchanged. Configuring unattended order approval alone does not start an autonomous daemon.

## Configure an isolated Paper account

Use one private `TI_DATA_DIR` for this account and keep it at the same absolute path. Do not use a live directory for development. All processes coordinating this Paper account must use the same directory and version.

```bash
export TI_DATA_DIR="$HOME/ti-autonomous-paper"
umask 077
mkdir -p "$TI_DATA_DIR/agent"
```

Configure the model's normal authentication using Ti's existing login/configuration workflow. Do not put exchange credentials, model tokens or shell commands in the files below. Model selection is explicit; an unavailable model is an error, not permission to select another provider.

Create `agent/trading.json` under this directory. The numbers below are **illustrative Paper values, not live risk recommendations or automatically installed defaults**. Review every hard limit. Other interactive configuration fields retain their existing defaults.

```json
{
  "mode": "paper",
  "exchange": "binance",
  "marketType": "spot",
  "quoteCurrency": "USDT",
  "orderApproval": "unattended",
  "paper": {
    "startQuote": 10000,
    "feeRate": 0.001
  },
  "risk": {
    "maxOrderNotional": 200,
    "maxDailyNotional": 2000,
    "allowedSymbols": [],
    "account": {
      "maxGrossExposure": 1000,
      "maxNetExposure": 800,
      "maxAssetExposure": 400,
      "maxLeverage": 1,
      "maxMarginUsagePct": 50,
      "maxDailyLoss": 100,
      "maxDrawdown": 200,
      "maxDataAgeMs": 30000,
      "maxPriceDeviationPct": 2,
      "minDepthRatio": 2,
      "minLiquidationDistancePct": 10,
      "minProtectionCoveragePct": 95,
      "maxStopDistancePct": 10,
      "cancelEntriesOnBreach": true,
      "reduceOnBreach": true
    }
  }
}
```

Create `agent/autonomous.json`. Replace the provider/model with an exact model already available in your Ti configuration. The scope must match `trading.json`; there are no command-line account overrides in this mode.

```json
{
  "enabled": true,
  "mode": "paper",
  "exchange": "binance",
  "marketType": "spot",
  "quoteCurrency": "USDT",
  "objective": "Research and manage this Paper account within my hard limits. Decide when to act again; waiting is acceptable.",
  "provider": "openai",
  "model": "gpt-5",
  "pollIntervalMs": 5000,
  "modelTimeoutMs": 180000,
  "serviceTimeoutMs": 15000,
  "maxAttempts": 3,
  "retryBaseMs": 2000,
  "retryMaxMs": 60000,
  "protectionAttempts": 3,
  "services": ["market-lab"]
}
```

All numeric operational settings must be supplied. Millisecond settings and the combined startup timeout must fit Node's 2,147,483,647 ms timer range. `pollIntervalMs` controls observation and wake resolution, not a trading frequency. `modelTimeoutMs` bounds a model decision. `serviceTimeoutMs` bounds supervised operations; a timeout does not prove that an account mutation was rejected. `maxAttempts` and retry bounds control observation-only model retries and supervision backoff. `protectionAttempts` bounds consecutive failed repairs; successful coverage resets that failure count.

Reviewed service names are `market-lab`, `web-search`, `zhihu-research`, `freqtrade`, `market-research` and `subagent`. Enable only installed/configured services. Their normal service credentials and endpoint requirements still apply. The runtime does not discover arbitrary user extensions. Freqtrade is a research-only sidecar, never an independent live executor.

With `subagent` enabled, the model also gets `subagent_agents`, `subagent_sessions` and `subagent_evidence`. It can select technical, event, derivatives, strategy or review specialists, use independent parallel tasks, and continue an existing research thread with `sessionId` + `task`. No fixed research order or voting is required. The internal candle bridge and reviewed market-query adapters remain available to children even if `market-lab` is not exposed directly to the parent; news and Freqtrade still require their corresponding services.

Child JSONL histories and run records live under `agent/subagents`, scoped to this actual account and stable autonomous ownership, not the temporary model worker's session ID. A later wake or restarted worker can discover and resume the same child sessions. Only one writer may use a child conversation at a time; missing or corrupt history is an error, not a new conversation. There are no permanently running child agents, and histories are not automatically deleted. Monitor disk growth and include them in stopped-directory backups. Historical reports must be refreshed before market decisions; neither reports, reviews nor proposals grant execution authority.

The narrower `market-research` service uses the same persistent runtime with proposals disabled. It accepts `sessionId` + `question`, or `listSessions: true` to recover its technical sessions. Child analysis time, turns, tool calls and cumulative tokens have no default limits, and there is no default child-batch deadline; explicitly configured role budgets still apply. The supervisor's required `modelTimeoutMs` remains an independent outer deadline and can interrupt research even when child budgets are omitted. Set it deliberately for the intended decision duration; unlimited child budgets do not override it.

## Start and control the runtime

In a Ti TUI launched with the same `TI_DATA_DIR`, use:

```text
/autonomous start
/autonomous status
/autonomous pause
/autonomous resume
/autonomous stop
```

Bare `/autonomous` shows status. Subcommands appear in slash completion. Configuration above is still required: this command does not invent risk limits, enable live trading or select a model for you. Errors appear in the transcript with configuration guidance.

Controls are bound to the TUI's active account, including Paper/live, exchange, market, quote currency and position mode. An account mismatch is rejected; switch to the matching account before controlling its daemon. `start` and `resume` wait for the current TUI model turn to finish. `pause`, `stop` and `status` do not wait. The daemon remains independent: exiting the TUI does not stop it, and `/autonomous stop` does not close positions.

For an installed candidate:

```bash
ti --autonomous start
ti --autonomous status
ti --autonomous pause
ti --autonomous resume
ti --autonomous stop
```

For source development, replace `ti` with:

```bash
./node_modules/.bin/tsx --tsconfig tsconfig.json packages/trading-agent/src/cli.ts
```

`start` starts a detached process and waits for startup reconciliation and readiness. Closing the launching terminal does not stop it. Diagnostics go to `agent/autonomous.log`; persistent controls and decisions are available through `status`. A second daemon using that directory is rejected.

`ti --autonomous run` runs in the foreground for a service manager. A detached start is not installation of a boot service: operating-system restarts still require your service manager or another explicit start.

| Operation | Effect |
| --- | --- |
| `pause` | Stop model work. Independent risk supervision continues. No implicit blanket cancellation or liquidation. |
| `resume` | Operator-only resume of model decisions. Does not clear a loss trip, unknown order or unresolved account-setting change. |
| `stop` | Request termination of model work and the daemon. Does not cancel orders or close positions. An already-started submission can still complete. |
| Model cancellation | Cancels a specified order through engine checks. Removing required protection is rejected. |
| Model `close_position` | Verified full reduction; Paper atomically cancels matching protective orders and closes the position. It is not implied by `stop`. |

Stopping also stops this daemon's independent monitor. Native live protection belongs to the venue; Paper protection is simulated and settles on Paper account observations, not in a real exchange after all Ti processes stop.

`SIGTERM` and `SIGINT` request orderly shutdown. Never kill a process merely by matching its name. Use the recorded process identity and verify `status` after requesting a stop.

## Hard-risk reference

Risk rules live in `trading-risk`; `trading-engine` supplies account facts, performs the same rules for preview and final admission, reserves quota atomically and owns mutations. Tool code does not decide numerical risk limits.

| Fields | Meaning |
| --- | --- |
| `maxOrderNotional`, `maxDailyNotional` | Opening transaction-flow limits in quote currency; not current exposure or a loss budget. Existing Paper quota accumulates until an explicit operator reset. |
| `allowedSymbols` | Opening whitelist; an empty list adds no instrument restriction. It does not trap an existing position after the whitelist changes. |
| `maxGrossExposure` | Sum of absolute positions and increasing pending-order exposure. Unknown submitting orders retain reservations and block further entries. |
| `maxNetExposure` | Worst reachable signed exposure, allowing pending buys and sells to fill independently instead of incorrectly netting both. |
| `maxAssetExposure` | Absolute exposure per underlying asset, including its increasing pending orders. |
| `maxLeverage` | Maximum gross/equity ratio and permitted new futures leverage setting. |
| `maxMarginUsagePct` | Maximum margin usage as a percentage of equity. |
| `maxDailyLoss`, `maxDrawdown` | Absolute quote-currency loss and peak drawdown of equity adjusted for cumulative external capital flows. Includes Paper fees and realized/unrealized PnL. |
| `maxDataAgeMs` | Maximum age of account/price/depth evidence; missing or future-dated evidence is not zero risk. |
| `maxPriceDeviationPct`, `minDepthRatio` | Admission price deviation and available same-side depth relative to requested quantity. |
| `minLiquidationDistancePct` | Minimum observed and projected post-fill liquidation distance for futures positions. Paper uses its isolated-lot accounting; unavailable projections block openings. |
| `minProtectionCoveragePct`, `maxStopDistancePct` | Required executable stop-market coverage and maximum distance from current price. Stop-limit orders are not counted as guaranteed executable coverage. |
| `cancelEntriesOnBreach` | Independently attempt cancellation of increasing working orders after a hard-risk breach. |
| `reduceOnBreach` | Independently attempt full, controlled closure of positions after a breach when current reduction facts are usable. This is not a minimal-allocation rebalancer. |

Maximum thresholds are positive and finite. The three `min*` thresholds may explicitly be zero. In particular, zero minimum protection coverage does not impose a mandatory opening stop. Percentage coverage, stop distance, margin usage and liquidation distance cannot exceed 100.

Deposits are not profits and withdrawals are not trading losses. Daily loss uses UTC observations; an outage across midnight conservatively includes losses since the preceding observation rather than resetting at an already-depleted restart balance. A hard loss trip remains latched across days and restarts. There is no model tool or `resume` shortcut that clears it.

Persisted hard limits are compared with startup configuration. An in-place limit change or a changed Paper account epoch requires operator reconciliation; this release does not implement a hard-limit migration/loss-trip reset command. Do not delete risk state or switch directories to hide a breach.

Reduction bypasses opening-only whitelist, single-order and flow-quota limits, but still verifies current holdings, side, quantity, freshness, market constraints and futures reduce-only/hedge rules. Cancelling a required stop, widening a stop beyond its hard limit or changing risk settings without post-change evidence is not classified as harmless.

## Events and model tools

The daemon waits between observations. It starts model work for durable startup, timer, price/position-PnL condition, fill/order, position or risk events. It does not invoke the model just because another idle poll occurred. Order/position events are derived from authoritative account observations, including manual account changes.

The model can inspect capabilities and current facts with `query_trading`; submit or preview an order; submit supported OCOs; cancel orders; request account setting changes; close positions; atomically replace Paper stops; and create, replace, list or cancel its own wakes.

`schedule_wake` uses the existing trigger schema. For example:

```json
{
  "id": "review-later",
  "name": "Review later",
  "when": { "kind": "time", "at": "2030-01-01T12:00:00.000Z" },
  "then": { "kind": "wake_agent", "message": "Reassess current facts; no trade is required." },
  "policy": { "mode": "once" }
}
```

The returned `autonomous-…` identifier is used by `cancel_wake`. Reusing the logical ID replaces that model-owned wake. Supported condition facts are `price:SYMBOL` and `position_pnl_pct:SYMBOL`; unsupported facts are rejected rather than treated as known. Autonomous wakes are not consumed by the interactive trigger monitor.

Account tool results identify their source and receipt time. Research results retain provider evidence and add received-time/source/limitation metadata. Transport failures are recorded with bounded diagnostic categories instead of copying raw authenticated responses into model state.

## Protection and recovery

With protection required, an opening intent includes a model-chosen `protectionStopPrice`. The independent engine supervisor observes actual filled holdings, maintains coverage, and adjusts for partial fills. It does not assume requested quantity was filled. On failure it blocks entries, performs configured cancellations/reductions, and keeps unresolved work visible.

Paper stop replacement and full protected closure commit cancellation and replacement under the existing account lock and durable account transaction. Failed validation preserves the original durable stop. Adapters without an atomic primitive reject the operation instead of opening an unprotected cancellation gap. Paper native OCOs require available holdings; atomic replacement of an existing stop with an OCO and futures OCOs are not implemented.

On restart, execution recovery runs before model work. An interrupted decision that attempted mutations is not replayed into a fresh model round. Unfinished action references remain visible. Event receipts, decision/action identities and execution intent tombstones prevent retries from resubmitting the same intent; identical order parameters alone do not merge independent trades.

An unknown submission keeps its risk reservation. Running supervision performs bounded client-ID recovery of **unknown** records without revoking another task's still-prepared submission. It never resends an unresolved order. Cancellations and account-setting changes have durable mutation identities; unknown outcomes block new entries until observed application can be reconciled.

A timed-out account RPC returns its stable intent identity and an unknown outcome. Work not yet submitted is aborted, and new mutations in that decision remain blocked even if the original call later completes. Abort is checked again after final asynchronous preflight. Failed mutation reconciliation retains the entry block but does not prevent independent account inspection or safe protection work. Unavailable wake facts likewise do not suppress unrelated timers.

Do not assume `status` is current account truth. It reports local progress and last observations; model account decisions must query the exchange/Paper ledger and execution state. Existing `/recovery` procedures still apply to unresolved order records.

Risk-change events retain source/time, equity, capital-flow and margin observations plus action results in their bounded decision history. These are historical audit evidence, never a second balance ledger. Exact event receipts and intent tombstones are retained independently of bounded summaries; automatic identity-index compaction is not implemented, so operators must monitor data-directory growth.

Current local file locks record owner PID/host. A verified dead local owner can be recovered; age alone cannot evict a suspended writer. Legacy empty locks, locks on another host and interrupted reclaim locks require the operator procedure in the [operations runbook](trading-operations.md). Keep backups of the whole stopped data directory, not individual state files.

## Authority and remaining limits

The supervisor owns the execution engine and persistent risk state. A separate model process uses `AgentSession` with fixed RPC trading tools and explicitly selected, reviewed research extensions. It has no general shell, file-edit/read, arbitrary-code, credential, risk-reset, resume or extension-loading tool. Subagents return research/proposals; execution stays with the same engine.

This is **not an operating-system sandbox**. The absence of arbitrary-code tools is intentional. Do not add a generic command, code evaluator or user-controlled extension to this mode without an OS-enforced separation of model computation from credentials, hard-risk configuration and ledgers. TypeScript visibility, frozen objects and prompts are not that separation.

Still unsupported: autonomous live adapters with complete account-risk evidence; cross-margin liquidation projection and risk-setting changes with exposure; atomic stop-to-OCO replacement; partial closure of fully protection-locked holdings (the atomic close currently closes the whole position); automatic installation of an OS boot service; and administrative migration/reset of installed hard-risk policy. Paper does not model funding payments, exchange-specific slippage or real venue outages/liquidations accurately. A stop threshold cannot guarantee a maximum realized loss.

Deterministic tests exercise runtime control, model stand-ins, IPC startup failure, isolated Paper ledgers, risk admission and execution recovery. They do not evaluate strategy returns or substitute for long-duration observation, live adapter integration or deployment review.
