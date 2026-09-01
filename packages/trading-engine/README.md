# Ti Trading Engine

`@earendil-works/ti-trading-engine` is the framework-independent trading domain package used by Ti and other applications. It owns normalized exchange contracts, ccxt and paper adapters, order planning, risk reservations, protection logic, and `TradingEngine` orchestration.

The engine does not depend on the Ti agent, LLM runtime, TUI, or extensions. It may depend on the exchange SDK (`ccxt`). Applications provide configuration and choose how to expose the engine; the engine itself remains independent of persistence, prompts, and user-interface concerns.

## Public surface

The package exports normalized types and contracts for market data, balances, positions, orders, conditional orders, OCO orders, and contract metadata. It provides:

- `CcxtExchangeClient` for live exchange access through ccxt;
- `PaperExchangeClient` for local paper accounts driven by public market data;
- shared order planning for amount/notional resolution, market-family and contract-unit validation, and trigger checks;
- risk accounting with atomic reservations and mode-specific usage state;
- protection predicates and coverage helpers for stop-loss and related orders;
- `TradingEngine` for planning, risk checks, confirmation policy, submission, and reservation settlement.

`TradingEngine` fixes the identity of its client (`id`, `mode`, and `quoteCurrency`). Safe mutable policy updates must not make that identity or its planning context disagree with the client. Exchange, mode, market family, and quote-currency changes are performed by replacing the client and engine at the application runtime boundary.

## Safety and execution

Paper mode is the safe default in Ti. Live execution requires exchange credentials and follows the application's live confirmation policy, including headless rejection when confirmation is required. Risk limits are enforced by the engine rather than treated as an LLM prompt convention. Confirmation cancellation and known submission failures release reservations; an explicitly unknown submission commits a reservation exactly once.

The engine is independently buildable, testable, and packable:

```bash
npm --prefix packages/trading-engine run build
npm --prefix packages/trading-engine run test
npm pack --dry-run --workspace packages/trading-engine
```

## Release order

Release and publish the engine package first. After the published engine version is available, update the exact dependency in `ti-trader`, then build and publish `ti-trader`. Real npm publication is a maintainer action and is not performed by local migration work.
