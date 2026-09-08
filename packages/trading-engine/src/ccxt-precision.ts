/** ccxt `precisionMode` constants (`DECIMAL_PLACES = 2`, `TICK_SIZE = 4`). */
const CCXT_DECIMAL_PLACES = 2;
const CCXT_TICK_SIZE = 4;

/**
 * Lot step in the exchange amount unit.
 * TICK_SIZE stores the step directly (Binance DOGE USDM `1` means 1 contract).
 * DECIMAL_PLACES stores an integer digit count (`1` means 0.1).
 */
export function amountStepFromCcxtPrecision(
	precisionAmount: number | undefined,
	precisionMode: number | undefined,
): number | undefined {
	if (precisionAmount === undefined || !Number.isFinite(precisionAmount) || precisionAmount < 0) return undefined;
	if (precisionMode === CCXT_TICK_SIZE) return precisionAmount > 0 ? precisionAmount : undefined;
	if (precisionMode === CCXT_DECIMAL_PLACES) {
		if (!Number.isInteger(precisionAmount)) return undefined;
		return 10 ** -precisionAmount;
	}
	return undefined;
}

/** Decimal places implied by a lot step, matching ccxt TICK_SIZE stringification. */
export function amountStepDecimals(step: number): number | undefined {
	if (!Number.isFinite(step) || step <= 0) return undefined;
	const text = step.toFixed(16).replace(/0+$/, "").replace(/\.$/, "");
	const dot = text.indexOf(".");
	const decimals = dot === -1 ? 0 : text.length - dot - 1;
	return decimals > 16 ? undefined : decimals;
}

/**
 * Truncate `amount` onto `step`, matching ccxt `amountToPrecision` (TRUNCATE).
 * Paper and live adapters both go through that API, so planning must not round.
 */
export function truncateToAmountStep(amount: number, step: number): number | undefined {
	const decimals = amountStepDecimals(step);
	if (decimals === undefined || !Number.isFinite(amount) || amount <= 0) return undefined;
	const units = Math.floor(amount / step + 1e-12);
	if (!Number.isFinite(units) || units <= 0) return undefined;
	const snapped = Number((units * step).toFixed(decimals));
	return Number.isFinite(snapped) && snapped > 0 ? snapped : undefined;
}
