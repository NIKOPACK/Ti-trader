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
