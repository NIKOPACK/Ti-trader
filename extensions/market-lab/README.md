# Ti Market Lab

`ti-market-lab` 是 Ti 的只读市场分析扩展。数据源固定为 Binance 公共现货（SPOT）已收盘 K 线，不跟随 Ti 当前交易所配置，也不读取期货/合约行情。它计算技术指标并返回市场偏向；不会读取 Ti 凭证，不访问账户，不下单、不撤单，也不修改风险配置。

## 加载

默认 `ti` 会话会加载本扩展，不必再传 `--extension`。`--no-extensions` 只跳过用户扩展，不会卸载这套内置量化工具。

单独调试时仍可显式加载：

```bash
ti --extension ./extensions/market-lab/index.ts
```

正式发布包将编译后的 `dist/market-lab/` 打进 `ti-trader`。

## 工具

- `calculate_indicators`：计算快/慢 EMA、RSI、MACD、ATR、Bollinger Bands，以及成交量均值和成交量比率。可选 `emaFast`、`emaSlow`、`rsiPeriod`、`atrPeriod`（整数 2–200）；默认仍是 EMA20/50、RSI14、ATR14。样本不够的字段为 `null`，不编造。
- `evaluate_strategy`：对命名预设评分：`ema-cross`、`rsi-revert`、`macd-hist`。内部分析路径与 `/indicators`、`/signal` 相同，只返回 `bias`、`event`、`reasons` 和失效参考，不下单。
- `screen_markets`：对最多 8 个现货标的做只读扫描，按事件排序；单个标的失败不影响其余结果。
- `simulate_rule`：在已收盘 K 线上回放命名预设。只统计 discrete 事件（交叉、超买超卖），非重叠持有 `horizon` 根 K 线（默认 5）。返回交易次数、胜率和平均收益，不含手续费、滑点和成交；不是回测，也不下单。

所有工具都使用 TypeBox schema，最多读取 200 根 K 线，响应体最多 256 KiB，并排除当前尚未收盘的 K 线。扩展还校验 OHLCV 数值、时间顺序和高低价关系。数据不足、请求失败或数据非法时会报错，不伪造指标。

## 命令

```text
/indicators BTC/USDT 1h
/signal BTC/USDT 4h
/signal BTC/USDT 1h rsi-revert
/screen BTC/USDT ETH/USDT 1h ema-cross
/replay BTC/USDT 1h rsi-revert
```

命令只显示分析摘要，不触发模型回合或交易。预设为 `ema-cross`（默认）、`rsi-revert`、`macd-hist`。

## 安全限制

- 只访问固定的 `https://api.binance.com`。
- 只使用 Binance 公共现货 K 线端点。
- 不发送 API key、secret、Cookie 或 Authorization。
- 请求超时 10 秒，支持 Pi 工具取消。
- 禁止重定向，限制最多 200 根 K 线和 256 KiB 响应体。
- 外部市场数据可能延迟、缺失或异常，指标不保证准确。
- 不能把信号当作收益保证或投资建议。

如果用户要求执行交易，仍必须由 Ti 原生 `buy`、`sell` 或 `place_oco` 工具处理，并经过 Ti 原生 trading-engine 的规划与风控路径、实盘确认和订单状态验证。该扩展自身没有任何交易执行路径。

## 当前边界

数据源是 Binance 公共现货已收盘 K 线（`https://api.binance.com` `/api/v3/klines`），不是 Ti 当前交易所、也不是期货/合约市场。因此不支持 Binance USDⓈ-M 合约 K 线，也不自动跟随 Ti 的 `exchange` / `market` 配置。未来若接入 Ti 的只读行情桥接，应保持本扩展没有交易客户端和账户权限的边界。
