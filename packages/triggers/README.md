# Ti Triggers

`@earendil-works/ti-triggers` is an experimental, deterministic conditional-trigger package. It evaluates trigger inputs without side effects: evaluation is pure with respect to its inputs and does not perform network, account, order, persistence, or other external I/O.

Actions are limited to `notify` and `wake_agent`. This package does not submit, cancel, or manage orders, and must not be treated as trading authorization or risk approval. Any order still has to go through the trading-engine risk and execution path, including live-order confirmation.

## `ti-trader` monitor

`ti-trader` registers an experimental `/trigger` command (`add` / `list` / `remove` / `clear`). Definitions and runtime state live in memory for the current session only; they are not written to disk and do not survive restart or a second process.

- The monitor polls `TradingRuntime.marketData` (prices) and `tradingEngine.getPositions()` (PnL facts). It does not call order-placement APIs.
- Price facts use the ticker timestamp. Missing, non-finite, or non-positive timestamps are skipped. Observations older than five minutes evaluate as unknown and do not fire.
- `wake_agent` in paper interactive sessions can start a follow-up agent turn. Live sessions and `--print` never auto-wake: they record a `[trigger:id]` transcript message (live also notifies). That message is an observation, not permission to trade.

It is independently buildable and testable:

```bash
npm --prefix packages/triggers run build
npm --prefix packages/triggers run test
```
