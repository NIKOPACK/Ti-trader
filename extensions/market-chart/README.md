# Ti Market Chart

`ti-market-chart-extension` renders read-only TUI market snapshots for agent explanations. The agent supplies the scenario levels; the extension reads the current Ti runtime snapshot, calculates absolute and percentage distances from the latest price, and appends a collapsible chart entry to the conversation.

The `show_market_view` tool accepts `symbol`, `timeframe`, `bias`, optional `entryZone`, `waitZone`, `invalidation`, `targets`, and a short `rationale`. It never creates, cancels, or authorizes orders. `/chart BTC/USDT 1h` opens a neutral snapshot manually.

The extension requires Ti TUI mode and imports `getTrading()` from `ti-trader`; it does not access credentials directly. Forming candles retain the engine's `closed` field and invalid market data is reported as an error.
