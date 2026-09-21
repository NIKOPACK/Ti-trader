# Ti Triggers

`@nikopack/ti-triggers` is an experimental, deterministic conditional-trigger package. It evaluates trigger inputs without side effects: evaluation is pure with respect to its inputs and does not perform network, account, order, persistence, or other external I/O.

Actions are limited to `notify` and `wake_agent`. This package does not submit, cancel, or manage orders, and must not be treated as trading authorization or risk approval. Any order still has to go through the trading-engine risk and execution path, including live-order confirmation.

## `ti-trader` monitor

`ti-trader` exposes experimental triggers as `/monitor trigger` (`add` / `list` / `remove` / `clear`).

- Definitions, runtime state, pending notifications, and fact baselines are durably scoped by non-secret account identity, mode, exchange, market type, quote currency, and position mode. They survive restart and are isolated from other accounts/scopes.
- The monitor polls `TradingRuntime.marketData` (prices) and `tradingEngine.getPositions()` (PnL facts). It does not call order-placement APIs.
- Price facts use the ticker timestamp. Missing, non-finite, or non-positive timestamps are skipped. Observations older than five minutes evaluate as unknown and do not fire.
- Supported facts are `price:SYMBOL`, `position_pnl_pct:SYMBOL`, and for hedge-mode ambiguity `position_pnl_pct:SYMBOL:LONG` or `position_pnl_pct:SYMBOL:SHORT`. Unsupported facts are rejected when adding a monitor trigger. If an unqualified PnL fact matches both hedge sides, it evaluates as unknown and the monitor asks for an explicit side.
- `change` conditions use persisted bounded history for the requested `windowSec` instead of the last two samples. The baseline is the most recent observation at or before the window start, at most 15 seconds earlier; no interpolation is performed. If no such baseline exists, the result is unknown. Windows are capped at one hour. History retains one observation per five-second bucket, up to 1024 samples per fact, so faster pollers cannot evict the one-hour baseline. Ordinary monitors and autonomous wakes share this history without shortening each other's windows.
- `cross` requires a fresh, earlier previous observation. Repeated or out-of-order observations do not create edges.
- `wake_agent` in paper interactive sessions can start a follow-up agent turn only for newly-created trigger events. Redelivered durable events are notification-only. Live sessions and `--print` never auto-wake: they record a `[trigger:id]` transcript message (live also notifies). That message is an observation, not permission to trade.
- Ordinary monitoring stops when the session exits. Restart restores definitions, cooldowns and recent observations; it cannot reconstruct crossings that happened and reversed while offline. Pending notifications expire after at most five minutes. Delivery has bounded retry attempts with a stable event ID, not exactly-once delivery.

Conditions support comparisons, crossings, window changes, absolute times, `all` / `any` / `not`, and nested `stable_for`. Unknown input does not count as false and does not re-arm an edge. Missing observations or a long polling gap invalidate `stable_for` continuity rather than counting downtime as observed truth.

Policies are `once` (fire once, including an already-true initial condition), `on_edge` (fire initially if true, then require an observed false-to-true transition), and `while_true` (repeat on new qualifying observations). `cooldownSec` limits firing frequency; an edge suppressed during cooldown is not deferred until cooldown ends. `expiresAt` is an optional absolute expiry; use an ISO timestamp with a timezone. Trigger definitions are limited to 30 atomic conditions, five nesting levels and ten children per logical group.

Example:

```text
/monitor trigger add {"id":"btc-move","name":"BTC 1m +1%","when":{"kind":"change","fact":{"key":"price:BTC/USDT"},"windowSec":60,"operator":"gte","value":1,"unit":"percent"},"then":{"kind":"wake_agent","message":"BTC moved at least 1% over the sampled 60s window; review context"},"policy":{"mode":"once"}}
/monitor trigger add {"id":"long-pnl","name":"BTC long PnL","when":{"kind":"compare","fact":{"key":"position_pnl_pct:BTC/USDT:USDT:LONG"},"operator":"lt","value":-2},"then":{"kind":"notify","message":"BTC long unrealized PnL below -2%"},"policy":{"mode":"on_edge","cooldownSec":300}}
```

It is independently buildable and testable:

```bash
npm --prefix packages/triggers run build
npm --prefix packages/triggers run test
```
