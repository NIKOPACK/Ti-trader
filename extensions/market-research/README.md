# Ti Market Research

`ti-market-research` 是独立的只读市场研究扩展。它启动隔离的 Pi 子进程，仅加载 `ti-market-lab` 的技术分析工具，生成带来源、时间和风险说明的研究报告。

## 使用

```bash
cd extensions/market-research
npx tsc -p tsconfig.json
cd ../..
ti --extension ./extensions/market-research --extension ./extensions/market-lab
```

工具：`market_research`，参数为 `question`，以及可选的 `symbol` 和 `timeframe`。

## 安全边界

子代理仅允许调用 `calculate_indicators`、`analyze_market_structure`、`generate_trade_signal`。它不读取 API key、账户、订单，不创建交易所客户端，也不执行下单、撤单、转账或提现。研究偏向不是交易授权。市场数据来自 market-lab 的公开 Binance 现货 K 线。
