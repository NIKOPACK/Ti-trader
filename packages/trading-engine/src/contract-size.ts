export type ContractSizeMarket = {
	contract?: boolean;
	linear?: boolean;
	inverse?: boolean;
	contractSize?: number;
};

export function futuresAmountsEqual(left: number, right: number): boolean {
	return (
		Number.isFinite(left) &&
		Number.isFinite(right) &&
		Math.abs(left - right) <= Number.EPSILON * 8 * Math.max(Math.abs(left), Math.abs(right))
	);
}

/** Resolve the exchange amount unit. Spot is 1; linear USDⓈ-M uses contractSize. */
export function contractSizeForMarket(market: ContractSizeMarket | undefined): number {
	if (!market) throw new Error("Exchange market metadata is unavailable; refusing to guess the amount unit");
	if (!market.contract) return 1;
	if (market.linear !== true || market.inverse === true) {
		throw new Error("Only linear USDⓈ-M contracts are supported; inverse or unidentified contracts are rejected");
	}
	const contractSize = market.contractSize;
	if (contractSize === undefined || !Number.isFinite(contractSize) || contractSize <= 0) {
		throw new Error("Futures market contractSize is unavailable; refusing to guess the amount unit");
	}
	return contractSize;
}
