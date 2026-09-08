import type { TradingConfig } from "./state.ts";

type DeepReadonly<Value> = Value extends (...args: never[]) => unknown
	? Value
	: Value extends readonly (infer Item)[]
		? readonly DeepReadonly<Item>[]
		: Value extends object
			? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
			: Value;

type ReadonlyTradingConfig = DeepReadonly<TradingConfig>;

export function requiresClientReplace(prev: ReadonlyTradingConfig, next: TradingConfig): boolean {
	return (
		prev.mode !== next.mode ||
		prev.exchange !== next.exchange ||
		prev.marketType !== next.marketType ||
		prev.quoteCurrency !== next.quoteCurrency ||
		prev.leverage !== next.leverage ||
		prev.marginType !== next.marginType ||
		prev.positionMode !== next.positionMode ||
		(prev.mode === "paper" && next.mode === "paper" && prev.paper.feeRate !== next.paper.feeRate)
	);
}

export function requiresPaperFeeRateChange(prev: ReadonlyTradingConfig, next: TradingConfig): boolean {
	return prev.mode === "paper" && next.mode === "paper" && prev.paper.feeRate !== next.paper.feeRate;
}

export function requiresAccountSwitchConfirmation(prev: ReadonlyTradingConfig, next: TradingConfig): boolean {
	return (
		prev.mode !== next.mode ||
		prev.exchange !== next.exchange ||
		prev.marketType !== next.marketType ||
		prev.quoteCurrency !== next.quoteCurrency
	);
}
