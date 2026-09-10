# Ti Freqtrade Extension

`ti-freqtrade` 是 Ti 的可选、只读 Freqtrade 侧车扩展。它通过 HTTP 调用本机 `freqtrade webserver`（或 dry-run REST），用来跑回测和读取策略进出场信号。扩展不 `spawn` Python、不读取交易所 key、不封装 `forceenter` / `forceexit` / `start` / `stop`，也不会下单。

执行仍必须走 Ti 原生 `check_order` → `buy` / `sell` / `place_oco`。

## 加载

默认不加载。设置非空的 `TI_FREQTRADE_URL` 后，`ti` 会话会自动加载；也可以 `--extension` 显式加载：

```bash
export TI_FREQTRADE_URL='http://127.0.0.1:8080'
export TI_FREQTRADE_USERNAME='Freqtrader'
export TI_FREQTRADE_PASSWORD='SuperSecret1!'
# 先在本机启动无 live key 的 webserver：
# freqtrade webserver --config user_data/config.json
ti
```

```bash
ti --extension ./extensions/freqtrade
```

`--extension` 且未设置 `TI_FREQTRADE_URL` 时，默认连接 `http://127.0.0.1:8080`。`--no-extensions` 不会卸载命令行显式指定的扩展，也不会卸载已因环境变量自动加载的 bundled 扩展。

发布包将编译后的 `dist/freqtrade/` 打进 `ti-trader`。

## 工具

- `freqtrade_status`：ping、runmode、策略列表、已下载品种样本。
- `freqtrade_backtest`：对 webserver 发回测，轮询到结束，返回精简指标（交易次数、盈亏、回撤、胜率、前几名品种）。不含成交明细。
- `freqtrade_signals`：`POST /api/v1/pair_history`，返回进出场计数和最近信号行。

所有结果标记为不可信研究数据，不是交易授权。

## 命令

```text
/ft-status
/ft-backtest SampleStrategy 20240101-20240201
/ft-signal SampleStrategy BTC/USDT 1h
/ft-signal SampleStrategy BTC/USDT 1h 20240101-20240201
/ft-login
```

`/ft-login` 把 REST 用户名和密码写到 `~/.ti-trader/agent/freqtrade-auth.json`（mode 600）。不要把密码当命令参数。可用 `TI_FREQTRADE_AUTH_FILE` 覆盖路径。环境变量 `TI_FREQTRADE_USERNAME` / `TI_FREQTRADE_PASSWORD` 优先于文件。

## 安全限制

- 只允许 `127.0.0.1` 或 `::1`（含 IPv4-mapped `::ffff:127.0.0.1`）。拒绝 `localhost` 主机名（避免 DNS rebinding）。
- 请求走独立 undici Agent，不把 Basic 凭证交给全局 `HTTP_PROXY`。
- 每次 backtest/signals 都重新读取 `/show_config`；live sidecar 会被拒绝。取消或超时会调用 `/backtest/abort`，且不复用已中止的 caller signal。
- URL 不得带路径、query、fragment 或 userinfo。
- HTTP 路径白名单：`/ping`、`/show_config`、`/version`、`/strategies`、`/available_pairs`、`/backtest`、`/backtest/abort`、`/pair_history`。
- 启动后读取 `/show_config`：`runmode=live` 或 `dry_run=false` 立即拒绝。
- `freqtrade_backtest` 只在 `runmode=webserver` 时可用。
- 禁止重定向；响应体上限 512 KiB（回测/pair_history 4 MiB）。
- 交易所 ccxt 连接和下单仍属于 Ti 交易核心，不由本扩展接管。
