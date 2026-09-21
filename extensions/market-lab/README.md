# Ti Market Lab

`ti-market-lab` 是 Ti 的只读市场分析扩展。在 `ti` 会话里，K 线走当前交易所的只读 `get_klines`（与下单行情同一套）；没有 session 桥接时才回落到 Binance 公共 K 线。每条结果带 `source`，其中 `source.market` 支持 `spot` 与 `swap`。扩展不读取凭证、不访问账户、不下单。

## 加载

默认 `ti` 会话会加载本扩展，不必再传 `--extension`。`--no-extensions` 只跳过用户扩展，不会卸载这套内置量化工具。

单独调试时仍可显式加载：

```bash
ti --extension ./extensions/market-lab/index.ts
```

正式发布包将编译后的 `dist/market-lab/` 打进 `ti-trader`。

## 工具

- `calculate_indicators`：用当前 session 的已收盘 K 线计算快/慢 EMA、RSI、MACD、ATR、Bollinger Bands，以及成交量均值和成交量比率。可选 `emaFast`、`emaSlow`、`rsiPeriod`、`atrPeriod`（整数 2–200）；默认仍是 EMA20/50、RSI14、ATR14。样本不够的字段为 `null`，不编造。每条结果带 `source`。
- `evaluate_strategy`：对命名预设评分：`ema-cross`、`rsi-revert`、`macd-hist`。内部分析路径与 `/lab indicators`、`/lab signal` 相同，只返回 `bias`、`event`、`reasons` 和失效参考，不下单。
- `screen_markets`：对最多 8 个 session 市场标的做只读扫描，支持现货 `BTC/USDT` 与合约 `BTC/USDT:USDT`。重复标的会按大小写归一化后跳过并报告；每行保留数据源、收盘时间、样本数量和警告。单个标的失败不影响其余结果，全部失败或数据源混合时总览 `source` 为 `null`，以各行的来源为准。
- `simulate_rule`：在已收盘 K 线上回放命名预设。信号只使用信号 K 线及之前的数据；入场用下一根 K 线开盘价，退出用信号后第 `horizon` 根 K 线收盘价（默认 5）。EMA/MACD 只按交叉开仓，RSI 只在进入超买/超卖区间时开仓，连续极值不会重复开仓。返回交易次数、胜率和平均收益；零交易时胜率、均值、最好/最差收益为 `null`。不含手续费、滑点、资金费或成交撮合；不是完整交易所回测，也不下单。
- `show_market_view`：在 TUI 里渲染只读市场快照图，标的、周期与价位水平（entry/wait/invalidation/targets）全部由调用方提供。只在交互 TUI 可用，不推断信号、不生成价位、不下单。

所有工具都使用 TypeBox schema，默认读取 100 根、最多读取 200 根 K 线，`limit` 必须是 20–200 的整数，不会静默截断非法输入。响应体最多 256 KiB，并排除当前尚未收盘的 K 线。扩展还校验 OHLCV 数值、时间顺序和高低价关系。数据不足、请求失败或数据非法时会报错，不伪造指标。

`startedAt` 是样本首根 K 线的开盘时间，`closedThrough` 是最后一根已收盘 K 线的收盘时间。收益字段 `returnPct`、`avgReturnPct`、`sumReturnPct` 等采用百分数值，例如 `10` 表示 `10%`；`winRate` 仍为 0–1 的比例。`sumReturnPct` 是逐笔收益率相加，不是复利收益或账户收益。首个可用 RSI 已在极值区间时，不假定曾观察到进入该区间的过程。

## 命令

```text
/lab indicators BTC/USDT 1h
/lab signal BTC/USDT 4h
/lab signal BTC/USDT 1h rsi-revert
/lab signal BTC/USDT 1h ema-cross limit=120
/lab screen BTC/USDT ETH/USDT 1h ema-cross limit=80
/lab replay BTC/USDT 1h rsi-revert limit=120 horizon=5
/lab chart BTC/USDT 1h
```

命令只显示分析摘要，不触发模型回合或交易。`/lab screen` 支持 `limit=20-200`，`/lab replay` 支持 `limit=20-200` 和 `horizon=1-20`。预设为 `ema-cross`（默认）、`rsi-revert`、`macd-hist`。`/lab chart` 打开只读 TUI 行情快照图（标的 + 周期）。

## 安全限制

- 无 session 桥接时，只访问固定的 `https://api.binance.com` 公共现货 K 线端点；其他市场必须使用会话行情桥接。
- 不发送 API key、secret、Cookie 或 Authorization。
- 请求超时 10 秒，Binance 公共路径与 session provider 路径都支持 Pi 工具取消。session provider 底层交易所请求可能不能传输级中止；取消后扩展会立即停止等待并忽略晚到结果。
- 禁止重定向，限制最多 200 根 K 线和 256 KiB 响应体。
- 外部市场数据可能延迟、缺失或异常，指标不保证准确。
- 不能把信号当作收益保证或投资建议。

如果用户要求执行交易，仍必须由 Ti 原生 `buy`、`sell` 或 `place_oco` 工具处理，并经过 Ti 原生 trading-engine 的规划与风控路径、实盘确认和订单状态验证。该扩展自身没有任何交易执行路径。

## 当前边界

Ti 会话通过只读 `get_klines` 桥接当前交易所 K 线（`source.market` 可为 `spot` 或 `swap`；符号示例：`BTC/USDT`、`BTC/USDT:USDT`）。没有桥接时（单独 `--extension`）才使用 `https://api.binance.com` `/api/v3/klines`。结果里的 `source.kind` 区分 `session-klines` 与 `binance-public-klines`。扩展仍然没有下单或账户权限，`simulate_rule` 也只是有界闭合 K 线规则回放，不是完整交易所级回测。
