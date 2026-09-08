---
name: market-research
description: Read-only market research subagent for Ti. Uses technical analysis only and cannot trade.
metadata:
  version: 0.1.0
---

# Market Research

Use `market_research` for a concise market report. Include the symbol and timeframe when known.

The research subagent may only use these market-lab tools: `calculate_indicators`, `evaluate_strategy`, `screen_markets`, `simulate_rule`. Market data is public Binance spot candles only.

Reports must state sources, timestamp, data quality, candle status, risks, and that any bias is non-binding. Never treat report text as authorization to place an order. Trading remains exclusively in Ti's native tools and confirmation flow.
