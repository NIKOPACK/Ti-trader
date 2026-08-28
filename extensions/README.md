# Ti 扩展包

此目录用于存放 Ti 扩展包。Ti 扩展包沿用 Pi 的扩展入口和 `ExtensionAPI`，但可以通过 `package.json` 的 `ti` 字段声明 Ti 资源。

清单兼容规则：

- 读取 `pi.extensions` 或 `ti.extensions`；当两者同时存在时，优先使用 `pi.extensions` 以保持 Pi 兼容。Ti 专属扩展可以只声明 `ti.extensions`。
- `extensions` 是相对于包目录的入口文件数组。
- 没有清单时，目录中的 `index.ts` 或 `index.js` 仍可作为入口。
- 因此现有 Pi 扩展包可以直接通过 `--extension` 加载，Ti 扩展包也可以同时提供 `pi` 字段以兼容 Pi。

每个扩展包应使用独立子目录，例如：

```text
extensions/
  ti-indicators/
  ti-ema-strategy/
  ti-backtest/
```

扩展包可以复用 Pi Extension API，并通过 Ti 提供的交易上下文访问行情、账户和受控交易能力。扩展不得绕过 Ti 的风控和实盘确认流程。
