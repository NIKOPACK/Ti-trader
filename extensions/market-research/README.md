# Ti Market Research

`ti-market-research` 是与 `ti-market-lab` 配套发布的只读市场研究扩展。它启动隔离的 Pi 子进程，仅加载相邻目录中的 `ti-market-lab` 技术分析工具，生成带来源、时间和风险说明的研究报告。`ti-trader` 发布包始终同时包含这两个目录。

## 使用

按需加载：设置 `TI_MARKET_RESEARCH=1`（或 `true` / `yes`），或通过 `--extension ./extensions/market-research` 显式加载。发布包仍与 `market-lab` 一起打进 tarball。

```bash
cd extensions/market-research
npx tsc -p tsconfig.json
cd ../..
ti --extension ./extensions/market-research
```

或：

```bash
TI_MARKET_RESEARCH=1 ti
```

工具：`market_research`，参数为 `question`，以及可选的 `symbol` 和 `timeframe`。

## 安全边界

子代理仅允许调用 `calculate_indicators`、`evaluate_strategy`、`screen_markets`、`simulate_rule`。它不读取 API key、账户、订单，不创建交易所客户端，也不执行下单、撤单、转账或提现。研究偏向不是交易授权。市场数据来自 market-lab 的公开 Binance 现货 K 线。
