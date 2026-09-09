# Trading operations runbook

This guide is for an operator of a human-confirmed Ti trading assistant. It covers local state, emergency pause, recovery evidence, backup and upgrade procedure. It does not authorize real trades or describe an unattended service.

## Prepare an isolated candidate

Use a dedicated operating-system user or a private data directory. Do not point development tools or a Paper exercise at a live account's data directory.

```bash
export TI_DATA_DIR="$HOME/ti-candidate-data"
umask 077
```

Install the reviewed candidate using the normal package workflow, or the isolated installer:

```bash
node scripts/trading-package-install.mjs --report /tmp/ti-release-evidence/installation.json
```

Confirm its version before opening a session. Initial configuration must be Paper; verify the displayed mode again after every account or market switch. Do not assume a restart resets a previously saved live configuration. For a controlled Paper soak, keep `TI_DATA_DIR` on that candidate and collect samples with `scripts/trading-paper-soak.mjs` rather than filling the observation record by hand.

API permissions must exclude withdrawals. Keep exchange credentials in Ti's credential store, not in commands, source files, logs or release evidence. Require confirmation for each live order during a pilot (`orderApproval: "confirm"`). Switching to `unattended` is an explicit opt-in and requires interactive confirmation in Settings or `/approval unattended`. Do not disable confirmation to work around a failed UI or recovery workflow.

Only one candidate version may write a given data directory. A state schema upgrade is also an operational boundary: binaries that ignore execution, pause or monitor fields are not safe rollback targets.

## Pause during an incident

Use the current Ti session:

```text
/risk pause Investigate account state
/risk show
```

Pausing is local and does not wait for a model turn or an exchange query. It blocks new exposure in the current mode, including an entry that is still awaiting confirmation. Paper and live controls are separate. Confirm the displayed mode before interpreting the result.

An already-started request may still reach the exchange. Existing limit, stop and OCO orders are not canceled by pausing or closing Ti. Verify them directly at the exchange. Preserve valid protection; do not indiscriminately cancel all orders just to clear a warning.

If a pause write fails, treat the control as unconfirmed. Do not continue trading on a success assumption. Stop initiating work from affected Ti processes and use the exchange's own account controls as needed. Preserve the state and diagnostic evidence for recovery.

## Resolve uncertain execution

An unknown submission is not a rejection. Keep new exposure paused while establishing which account and order the persisted execution ID refers to.

```text
/recovery
/recovery run
/audit
```

Startup and `/recovery run` use bounded correlated reads. Neither resubmits an order. Unknown executions block entries across the shared state store independently of the mode-scoped manual pause.

1. Confirm the original mode, exchange, market and account identity. Changing credentials or accounts does not resolve the original order.
2. Read the durable execution record and use its client order ID, list ID or exchange order ID. Matching only time, price and quantity is not sufficient correlation.
3. Query orders, trades and positions. A temporary not-found response is not proof of non-submission; allow bounded read retries without sending another order.
4. Keep partial fills and incomplete OCO evidence unresolved until the remaining liability is understood. Do not release quota merely because one leg is terminal.
5. Record the evidence for any manual decision. A reservation represents accounting, not a cancelable exchange order.

For a legacy reservation without a journal record, `/risk reconcile <id> commit|release` remains an operator action after exchange verification. `commit` counts quota; `release` returns it. Neither retries or cancels the original order. Do not reconcile an in-flight reservation owned by another active process.

Journal-linked claims must be resolved together with their execution using `/recovery resolve <id> commit|release <notional> <evidence-reference>` and interactive confirmation. This requires a verified terminal exchange outcome; `release` requires zero notional. Use a non-secret incident reference, not a raw authenticated exchange response. Keep other writers stopped while making a manual decision. An open or still-uncertain order is not terminal evidence.

After recovery has no unresolved entry block and exchange exposure is understood, use `/risk resume`. Confirmation applies to the captured pause, not to a newer pause set by another process. It does not reset quotas or disable other limits.

## Clear an interrupted maintenance operation

Account replacement and Paper reset hold a persisted maintenance fence: a record that blocks submissions until the state-changing operation completes. If `/recovery` reports an interrupted fence, stop every other writer and verify the account, journal, Paper ledger and risk state before confirming `/recovery maintenance <id> <evidence-reference>`. Clearing the fence does not resolve executions or remove manual pauses.

Successful maintenance advances a durable admission generation, separate from account identity. Processes and plans bound to an older generation cannot submit after the fence clears. If `/health` reports an outdated runtime, restart that Ti process using the intended data directory and current configuration. Do not reset quota or clear a pause to bypass this state.

The risk/execution file lock is a separate filesystem mechanism. It is not automatically taken over because its timestamp is old; configuration and Paper account locks follow the same rule. If a crash leaves an exact lock behind, first establish that all writers have stopped, preserve the state, and remove only that abandoned lock file. Do not delete the state file, delete all lock files indiscriminately or use lock age as proof that its owner is dead.

## Triage by symptom

`/health` reads local entry blocks, unresolved execution/reservation counts and recent monitor observations without querying an exchange. `unknown`, `stale` and `degraded` are not healthy fallbacks. A recent observation does not prove that a new order will succeed; disabled or idle monitors cannot certify current connectivity.

Fresh first-attempt order-fill and position-guard notifications retain the configured `monitor.wakeAgent` behavior in interactive Paper and live sessions. Live triggers remain notification-only. Restored and retried notifications never wake a trading turn. An analysis wake is not permission to bypass live confirmation or risk limits.

| Symptom | Safe response |
| --- | --- |
| Timeout after submit | Preserve unknown state; query the correlated order; do not resend |
| Disk full, permission failure or corrupt state | Block entries; repair storage or restore a verified consistent backup |
| Exchange 429, outage or missing credentials | Keep unresolved records; retry reads with backoff; do not infer rejection |
| Account identity differs from a pending execution | Restore the original account context for investigation; do not transfer its quota or mark it settled against another account |
| Runtime admission generation is stale | Restart the stale process; discard its old plans and reconfirm using current configuration |
| Monitor observations are stale | Treat connectivity and conditions as unknown; retain exchange-native protection |
| Duplicate notification after restart | Compare stable event IDs; a notification is not a new trading authorization |
| Order exists at the exchange but result persistence failed | Recover the existing order and accounting; do not start a replacement execution |

## Back up state consistently

Pause entries, let active submissions finish or remain explicitly unresolved, and stop **every** Ti writer using the directory. Stop monitors too. An archive taken while independently locked state files are changing is not a consistent snapshot.

Back up the entire `agent` directory, not just `trading.json`. Risk state, execution records, Paper ledgers, monitor state and identity metadata must be kept together. Include the candidate version and Git revision in a private operator record.

For a stopped directory, a local archive can be made with:

```bash
umask 077
tar -czf "$HOME/ti-state-backup.tgz" -C "$TI_DATA_DIR" agent
```

This archive includes credentials and model authentication. Keep it on an access-controlled encrypted local volume. Do not upload it to an issue, artifact service or support chat. Do not reuse the example destination if it would overwrite a required previous backup.

## Restore without hiding exchange exposure

First extract the backup into a **new private directory for inspection**, with all writers stopped. Do not overwrite the only copy of current state. Use the same schema-aware binary that created the backup, or a reviewed forward-compatible version.

For live recovery, point `TI_DATA_DIR` at the inspected copy and retain the original exchange credentials and account scope. Paper identity includes the absolute ledger path: a copy in another directory is a different account and cannot reconcile the original execution records. To recover a Paper account, preserve the current directory separately and place the inspected backup at its original absolute path while all writers remain stopped. Do not edit stored account identities to suppress a mismatch.

Start in the original account context, keep new entries paused, and reconcile before resuming. A backup is older than current exchange state: restoring it cannot undo orders or fills after the snapshot. Missing post-backup execution records require manual investigation, not permission to resend their intents.

A successful restore exercise must demonstrate that unknown executions, used/reserved quota, pause state and monitor state remain visible. Preserve the original directory until the recovered account and accounting have been reviewed.

## Upgrade and rollback

Pause, drain active work where possible, take a stopped-state backup, then upgrade risk, engine and agent together using their exact dependency versions. Check the installed CLI version and state diagnostics before enabling new activity.

Do not downgrade a live state directory to an older writer that drops safety fields. If the candidate has a defect, keep it paused and prefer a forward fix. A rollback using an older backup is a recovery exercise requiring exchange reconciliation, not a reset of account history.

## Release and pilot decision

Use the [release evidence gate](trading-release-evidence.md) for isolated regression reports, seven-day Paper observation records, recovery exercises, clean installation evidence and explicit pilot approval.

Do not label a candidate ready because implementation files exist or because a short offline run passed. The seven-day observation period must actually occur. Publication, real credentials, live pilot scope and notional limits require separate maintainer authorization.
