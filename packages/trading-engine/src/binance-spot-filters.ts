interface Decimal {
	value: bigint;
	scale: number;
}

interface Filter {
	filterType?: unknown;
	[key: string]: unknown;
}

export interface BinanceSpotPriceInput {
	label: string;
	value: number;
	/** Whether this price is a reliable execution-price reference for notional checks. */
	notionalReference?: boolean;
}

interface NotionalFilter extends Filter {
	filterType: "NOTIONAL" | "MIN_NOTIONAL";
}

function decimal(value: unknown): Decimal | undefined {
	const text = typeof value === "number" ? String(value) : typeof value === "string" ? value : undefined;
	if (!text || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return undefined;
	const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(text);
	if (!match) return undefined;
	const digits = `${match[2] ?? ""}${match[3] ?? match[4] ?? ""}`;
	const scale = (match[3]?.length ?? match[4]?.length ?? 0) - Number(match[5] ?? 0);
	const normalizedScale = Math.max(0, scale);
	const valueDigits = scale < 0 ? `${digits}${"0".repeat(-scale)}` : digits;
	const result = BigInt(valueDigits || "0") * (match[1] === "-" ? -1n : 1n);
	return { value: result, scale: normalizedScale };
}

function compare(left: Decimal, right: Decimal): number {
	const scale = Math.max(left.scale, right.scale);
	const a = left.value * 10n ** BigInt(scale - left.scale);
	const b = right.value * 10n ** BigInt(scale - right.scale);
	return a < b ? -1 : a > b ? 1 : 0;
}

function positiveFilter(filter: Filter, key: string): Decimal | undefined {
	const value = decimal(filter[key]);
	return value && value.value > 0n ? value : undefined;
}

function filtersFromInfo(info: unknown): Filter[] {
	if (!info || typeof info !== "object") return [];
	const raw = (info as Record<string, unknown>).filters;
	return Array.isArray(raw) ? raw.filter((item): item is Filter => !!item && typeof item === "object") : [];
}

function validateRange(value: Decimal, filter: Filter, minKey: string, maxKey: string, label: string): void {
	const min = positiveFilter(filter, minKey);
	const max = positiveFilter(filter, maxKey);
	if (min && compare(value, min) < 0)
		throw new Error(`${label} ${valueForMessage(value)} is below minimum ${filter[minKey]}`);
	if (max && compare(value, max) > 0)
		throw new Error(`${label} ${valueForMessage(value)} is above maximum ${filter[maxKey]}`);
}

function valueForMessage(value: Decimal): string {
	const sign = value.value < 0n ? "-" : "";
	const digits = (value.value < 0n ? -value.value : value.value).toString().padStart(value.scale + 1, "0");
	if (value.scale === 0) return `${sign}${digits}`;
	return `${sign}${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`.replace(/\.0+$/, "");
}

function validateGrid(value: Decimal, step: Decimal, label: string): void {
	const scale = Math.max(value.scale, step.scale);
	const a = value.value * 10n ** BigInt(scale - value.scale);
	const b = step.value * 10n ** BigInt(scale - step.scale);
	if (b > 0n && a % b !== 0n)
		throw new Error(`${label} is not on the Binance filter grid (step ${valueForMessage(step)})`);
}

/** Validate deterministic Binance Spot symbol filters before ccxt precision conversion. */
export function validateBinanceSpotFilters(
	info: unknown,
	amount: number,
	amountKind: "market" | "lot",
	prices: BinanceSpotPriceInput[],
	options: { marketOrder?: boolean; marketReference?: number } = {},
): void {
	const amountDecimal = decimal(amount);
	if (!amountDecimal || amountDecimal.value <= 0n) throw new Error("Amount must be a finite positive number");
	const filters = filtersFromInfo(info);
	const amountFilter = filters.find(
		(filter) => filter.filterType === (amountKind === "market" ? "MARKET_LOT_SIZE" : "LOT_SIZE"),
	);
	if (amountFilter) {
		validateRange(amountDecimal, amountFilter, "minQty", "maxQty", "Amount");
		const step = positiveFilter(amountFilter, "stepSize");
		if (step) validateGrid(amountDecimal, step, "Amount");
	}
	const priceFilter = filters.find((filter) => filter.filterType === "PRICE_FILTER");
	const parsedPrices = prices.map((price) => {
		const parsed = decimal(price.value);
		if (!parsed || parsed.value <= 0n) throw new Error(`${price.label} must be a finite positive number`);
		return { ...price, parsed };
	});
	if (priceFilter) {
		for (const price of parsedPrices) {
			validateRange(price.parsed, priceFilter, "minPrice", "maxPrice", price.label);
			const tick = positiveFilter(priceFilter, "tickSize");
			if (tick) validateGrid(price.parsed, tick, price.label);
		}
	}
	const notionalFilters = filters.filter(
		(filter): filter is NotionalFilter => filter.filterType === "NOTIONAL" || filter.filterType === "MIN_NOTIONAL",
	);
	const notionalPrices = parsedPrices.filter((item) => item.notionalReference);
	if (options.marketOrder && options.marketReference !== undefined) {
		const reference = decimal(options.marketReference);
		if (reference && reference.value > 0n)
			notionalPrices.push({
				label: "market reference",
				value: options.marketReference,
				parsed: reference,
				notionalReference: true,
			});
	}
	for (const price of notionalPrices) {
		for (const notionalFilter of notionalFilters) {
			if (options.marketOrder) {
				const minimumApplies =
					notionalFilter.filterType === "MIN_NOTIONAL"
						? notionalFilter.applyToMarket === true
						: notionalFilter.applyMinToMarket === true;
				const maximumApplies = notionalFilter.filterType === "NOTIONAL" && notionalFilter.applyMaxToMarket === true;
				if (!minimumApplies && !maximumApplies) continue;
				const min = positiveFilter(notionalFilter, "minNotional");
				const max = positiveFilter(notionalFilter, "maxNotional");
				const notional = decimal(amount) as Decimal;
				const productDecimal = {
					value: notional.value * price.parsed.value,
					scale: notional.scale + price.parsed.scale,
				};
				if (minimumApplies && min && compare(productDecimal, min) < 0)
					throw new Error(
						`Order notional ${valueForMessage(productDecimal)} is below minimum ${valueForMessage(min)}`,
					);
				if (maximumApplies && max && compare(productDecimal, max) > 0)
					throw new Error(
						`Order notional ${valueForMessage(productDecimal)} is above maximum ${valueForMessage(max)}`,
					);
				continue;
			}
			const notional = decimal(amount) as Decimal;
			const product = notional.value * price.parsed.value;
			const productDecimal = { value: product, scale: notional.scale + price.parsed.scale };
			validateRange(productDecimal, notionalFilter, "minNotional", "maxNotional", "Order notional");
		}
	}
}
