# Product readiness development plan

## Target and current scope

The first product target is a reliable, human-confirmed trading assistant, not an unattended trading service. A timeout must never be interpreted as proof that no order exists. A restart must not silently restore entry permission or cause a second submission.

The plan prioritizes recoverable execution and clear operator controls over more strategies, exchanges, backtests or a web UI. Paper results are workflow evidence, not evidence of live execution quality or profitability.

| Milestone | Priority | Depends on | Deliverable | Status |
| --- | --- | --- | --- | --- |
| M1: Persistent entry pause | P0 | Existing atomic risk store | Durable pause, final admission check, explicit resume | Implemented in working tree; not released |
| M2: Execution journal | P0 | M1 | Correlated, durable order intent and outcome records | Implemented in working tree; not released |
| M3: Restart reconciliation | P0 | M2 | Recover unresolved executions without resubmitting | Implemented in working tree; not released |
| M4: Supported capability matrix | P0 | Can run alongside M2; evidence required by M3 | One executable source of truth for supported combinations | Implemented; evidence is offline-only |
| M5: Durable monitoring and audit | P1 | M3 | Restart-aware monitoring, event history and health reporting | Implemented; bounded delivery and recovery behavior documented |
| M6: Operational release gates | P1 | M3, M4, M5 | Recovery procedures, release evidence and controlled rollout | Install and soak collectors implemented; seven-day Paper evidence still pending |

P0 work is required before expanding live use. P1 work is required before presenting the assistant as operationally mature. Completing M1 alone does not establish either claim.

## M1: Persistent entry pause

**Scope:** `packages/trading-risk/src/risk.ts`, engine admission in `packages/trading-engine/src/engine.ts`, agent state, commands, settings, localization and risk-status tools.

Implemented behavior:

- `/risk pause [reason]` writes a pause immediately, without waiting for an active agent turn or querying the exchange.
- Pause metadata contains a unique ID, reason and UTC timestamp. It shares the risk store and is scoped to Paper or live, not to one exchange or symbol.
- Entry reservation checks the pause atomically. The engine rechecks after asynchronous confirmation and before starting submission, releasing a never-submitted claim on rejection.
- `/risk resume` requires interactive human confirmation, the same runtime and pause ID, and no unsettled reservations in the current mode.
- Quota resets, live midnight rollover, runtime replacement and restart preserve the pause. Validated exits and cancellations retain their existing rules.
- `/risk show`, settings, startup warnings, the status bar and risk tools expose the control.

Acceptance: persistence roundtrip and invalid-state rejection; shared-store pause during ordinary/OCO confirmation; no exchange submission on denial; claim returned; stale resume rejected; pending claims block resume; reductions and cancellations remain available; read/write failures surface explicitly.

Boundaries: existing orders can still fill, already-started submissions cannot be recalled, and account-level leverage/margin changes are not blocked. This is not an exchange kill switch. All processes sharing the data directory must be upgraded or stopped before relying on pause metadata. Older writers may ignore or discard it.

Operator procedure: [pause and resume](../packages/trading-agent/README.md#暂停新增敞口与恢复). Library contract: [risk pause API](../packages/trading-risk/README.md#persistent-new-exposure-pause).

## M2: Durable execution journal

Implemented in the engine journal and the runtime's combined durable store. Preparation, quota claims, admission blocks, settlement and audit updates share transactions. Terminal retention follows settlement order; resolving an old record retains its newly supplied evidence. Paper transaction markers and both account snapshots synchronize before reset quota/fence completion.

**Problem:** risk reservations retain quota but do not constitute a complete order execution history. For example, a process can die after an exchange accepts an order but before its result is recorded. Retrying that intent can double the position.

**Implementation:**

- Add an engine-owned execution-record contract and state transitions; implement durable storage at the agent boundary rather than inside the exchange adapter.
- Assign a stable execution ID and client order/list ID before sending. Persist exchange, non-secret account identity, mode, market family, normalized intent, reservation ID and timestamps.
- Model at least prepared, submission-started, acknowledged, definite-rejection, unknown and reconciled outcomes. A started record without an acknowledgement remains unknown after restart.
- Wire normal and OCO submissions through the same contract, including reducing orders that have no quota-counting claim.
- Make journal writes and reservation changes recoverably correlated. Specify recovery for every write ordering before implementing it; two separate successful writes are not an atomic transaction.
- If the pre-submit journal write fails, do not send. If a post-submit write fails, retain uncertainty, block new entries independently of the manual pause and expose a non-retryable operator error.

**Primary files:** new execution-record/store modules beside `engine.ts`; `ccxt-client.ts`, `ccxt-binance-spot.ts`, normalized adapter types; agent `state.ts`, runtime construction and order-result rendering. Final filenames follow the existing persistence boundaries.

**Acceptance:** crash/failure injection before intent persistence, after reservation, immediately before sending, after exchange acceptance and during outcome persistence. Each scenario must leave either a known never-sent intent or an explicitly unresolved record. A single intent must never be silently submitted twice. No keys, secrets, tokens or complete credential-bearing requests may be persisted.

## M3: Startup and bounded automatic reconciliation

Implemented with original-scope lookup, bounded attempts, confirmed manual resolution and persistent maintenance. Maintenance fences exposure inspection before replacement/reset. Successful maintenance advances a durable admission generation; stale and during-maintenance runtimes cannot reuse old plans afterward. Startup captures the generation before configuration/client construction and rejects crossed generations. `/health` identifies stale runtimes requiring reinitialization.

**Problem:** a durable record is only useful if a subsequent process can resolve it safely. A single not-found response may reflect exchange indexing delay, not proof of rejection.

**Implementation:**

- On startup, enumerate unresolved records for their original account and exchange; pause entries before enabling submission.
- Query by persisted client ID or native order/list ID using proven adapter capabilities. Never infer identity from coincidentally matching amount and time.
- Reconcile fills, partial fills, cancellations, OCO legs and quota settlement idempotently.
- Retry reads with bounded backoff. Unknown, unsupported, unavailable or conflicting evidence keeps the record unresolved and the entry gate closed.
- Use per-record ownership/locking for multiple local processes. Repeated startup and recovery runs must not double-commit or double-release quota.
- Add a read-only recovery view and explicit manual-resolution workflow that records the observed evidence and decision. Do not implement automatic order resubmission.

**Primary files:** execution journal from M2; agent `context.ts`, startup hooks and commands; engine lookup adapters and risk reconciliation.

**Acceptance:** offline fake-exchange cases for accepted-before-crash, delayed visibility, rejection, partial fill, cancel/fill races, OCO partial evidence, missing credentials and two concurrent recoverers. Repeated recovery must converge on the same journal and quota state without any placement call. Corrupt state must block entry and produce actionable diagnostics.

## M4: Executable capability matrix

Implemented in `packages/trading-engine/src/capabilities.ts` and consumed by capability output, order planning/preflight and correlated recovery lookup. `status` describes technical support; `evidence.level` separately records `offline-contract`, `experimental` or `externally-verified`. No externally verified live integration is claimed.

| Profile | Submission scope | Recovery/cancellation boundary |
| --- | --- | --- |
| Paper spot | Market, limit, conditional, trailing and buy/sell OCO | Local correlated ID lookup and cancellation |
| Paper futures | Market, limit, conditional, trailing; one-way and hedge | Local order lookup; no futures OCO |
| Binance live spot | Ordinary/conditional/trailing and sell OCO | Native/client order IDs and list IDs with offline contract coverage |
| Binance live USD-M | Ordinary/conditional/trailing; one-way and hedge | Correlated client-ID recovery; conditional native-ID lookup/cancellation remains unknown |
| Other live venues | Experimental, metadata-dependent | Unknown capabilities stay unknown; existing experimental paths are not silently removed |

**Problem:** accepting an order parameter does not prove that an exchange supports submitting, finding, canceling and recovering that order.

**Implementation:**

- Define one matrix consumed by capability output, preflight and adapter contract cases.
- Cover exchange, Paper/live, market family, position mode, order type, quantity semantics, reduce/close behavior, query-by-client-ID and cancellation.
- Retain `supported`, `unsupported` and `unknown` as distinct states; attach evidence and constraints rather than promote unknown to supported.
- Start formal support with one documented spot path and one Binance USD-M futures path. Treat other existing combinations as experimental until evidence is sufficient; do not silently remove them.
- Keep Paper limitations explicit, especially funding, partial fills, slippage and exchange-specific liquidation behavior.

**Primary files:** `tools/capabilities.ts`, engine order input/plan/preflight and ccxt adapters, capability tests and package documentation.

**Acceptance:** every advertised supported combination has offline contract coverage for submission shape, lookup and cancellation. Unsupported/unknown behavior is consistent across preview and execution. Where live or testnet evidence is needed, record it separately and obtain maintainer authorization; mocked tests alone do not certify an exchange integration.

## M5: Durable monitoring, audit and health

Implemented in the scoped monitoring store and monitor extensions, with bilingual `/health` and journal-linked `/audit`. Notification callback failures do not stop observation collection. Unknown observations invalidate stable-for continuity, and independent time conditions remain evaluable. Queue selection considers eligibility and fair retry order before the bounded attempt budget. Live order-fill wakes require actual recent open-order evidence from the current lifecycle; persisted missing orders cannot become fresh merely because another poll completed.

**Implementation:**

- Persist trigger definitions, scope, baseline/cursor, cooldown and last-delivery identity. Version and validate the schema.
- Recover monitoring without treating a stale pre-restart observation as a fresh crossing. Define how missed intervals are handled; do not replay an unbounded backlog.
- Record state changes, execution transitions, pause/resume and manual reconciliation in a bounded, redacted audit history.
- Expose exchange connectivity, observation age, polling failures, unresolved executions and active entry blocks through an operator health view.
- Keep live trigger wakeups notification-only until separately reviewed. Persisted monitoring does not authorize autonomous trading.

**Primary files:** agent `trigger-monitor.ts`, `monitor.ts`, state stores, commands and execution/audit events from M2-M3.

**Acceptance:** restart at each baseline/delivery boundary; stale/future observations; disk failure; duplicate poll; two local processes; bounded event retention. Delivery guarantees must be documented honestly: where exactly-once delivery is impossible, use stable IDs and an explicit deduplication/retry policy.

## M6: Operational readiness and release

Operator procedures are in the [operations runbook](trading-operations.md). The [release evidence reference](trading-release-evidence.md) documents the isolated readiness runner and an executable, revision-bound pilot gate. Missing soak, installation or approval artifacts fail the gate rather than being treated as completed work.

**Implementation:**

- Document installation, configuration, API permission limits, data backup/restore, upgrade/downgrade restrictions, emergency pause and manual reconciliation.
- Add a release checklist tying every supported capability to its evidence and open known limitations.
- Make offline regression gates credential-independent. Keep explicitly authorized live/testnet exercises separate from normal CI.
- Run a controlled Paper soak with restart and transport/storage-failure injection; retain execution, recovery and monitor evidence.
- Define rollback rules that preserve unresolved records and pauses. Never downgrade a shared-data-directory writer to a version that drops safety state.
- Release risk, engine and agent in dependency order, with exact versions and maintainer authorization.

**Acceptance:** all P0 acceptance cases pass, no unresolved critical execution defect, and operator recovery is reproducible from documented steps. Require at least a seven-day controlled Paper soak with zero duplicate submissions and no lost unresolved records before a limited, human-confirmed live pilot. This duration is a proposed release gate, not a claim that such a soak has occurred. A live pilot requires a separately approved account scope and notional cap.

## Delivery policy

Each milestone ships as reviewable source, focused offline regressions, operator/API documentation and an unreleased changelog entry. Do not claim automated recovery while M2-M3 remain pending, or mature unattended operation after completing only the human-confirmed assistant milestones. Commits, publication and use of real funds require explicit authorization.
