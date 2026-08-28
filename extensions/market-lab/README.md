# Ti Market Lab

`ti-market-lab` 是 Ti 的只读市场分析扩展。它从 Binance 公共现货 K 线接口读取已收盘 K 线，计算技术指标并返回市场偏向；不会读取 Ti 凭证，不访问账户，不下单、不撤单，也不修改风险配置。

## 加载

```bash
# 开发源码
 ti --extension ./extensions/market-lab/index.ts

# 或先编译后加载扩展目录
cd extensions/market-lab
npx tsc -p tsconfig.json
cd ../..
ti --extension ./extensions/market-lab
```

也可以将目录复制到私有扩展目录后使用 `--extension` 加载。正式发布包需要将 `dist/index.js` 纳入发布文件。

## 工具

- `calculate_indicators`：计算 EMA20、EMA50、RSI14、MACD、ATR14、Bollinger Bands，以及 20 根成交量均值和成交量比率。
- `analyze_market_structure`：返回近期 20 根 K 线区间、趋势偏向和指标摘要。
- `generate_trade_signal`：返回非绑定的 bullish/bearish/insufficient-data 偏向。它是分析，不是交易授权。

所有工具都使用 TypeBox schema，最多读取 200 根 K 线，响应体最多 256 KiB，并排除当前尚未收盘的 K 线。扩展还校验 OHLCV 数值、时间顺序和高低价关系。数据不足、请求失败或数据非法时会报错，不伪造指标。

## 命令

```text
/indicators BTC/USDT 1h
/signal BTC/USDT 4h
```

命令只显示分析摘要，不触发模型回合或交易。

## 安全限制

- 只访问固定的 `https://api.binance.com`。
- 只使用 Binance 公共现货 K 线端点。
- 不发送 API key、secret、Cookie 或 Authorization。
- 请求超时 10 秒，支持 Pi 工具取消。
- 禁止重定向，限制最多 200 根 K 线和 256 KiB 响应体。
- 外部市场数据可能延迟、缺失或异常，指标不保证准确。
- 不能把信号当作收益保证或投资建议。

如果用户要求执行交易，仍必须由 Ti 原生 `buy`、`sell` 或 `place_oco` 工具处理，并经过 `TradingRuntime.checkRisk()`、实盘确认和订单状态验证。该扩展自身没有任何交易执行路径。

## 当前边界

第一版使用 Binance 公共现货数据，因此不支持 Binance USDⓈ-M 合约 K 线，也不自动跟随 Ti 当前交易所配置。未来若接入 Ti 的只读行情桥接，应保持本扩展没有交易客户端和账户权限的边界。
