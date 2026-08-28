export interface Candle {
	timestamp: number;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
}

export interface IndicatorPoint {
	timestamp: number;
	close: number;
	ema20?: number;
	ema50?: number;
	rsi14?: number;
	atr14?: number;
	macd?: number;
	macdSignal?: number;
	macdHistogram?: number;
	bbMiddle?: number;
	bbUpper?: number;
	bbLower?: number;
	volumeSma20?: number;
	volumeRatio?: number;
}

function finite(value: number): number | undefined {
	return Number.isFinite(value) ? value : undefined;
}

function sma(values: number[], period: number): number | undefined {
	if (values.length < period) return undefined;
	const slice = values.slice(-period);
	return finite(slice.reduce((sum, value) => sum + value, 0) / period);
}

function ema(values: number[], period: number): number | undefined {
	if (values.length < period) return undefined;
	let result = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
	const multiplier = 2 / (period + 1);
	for (const value of values.slice(period)) result = (value - result) * multiplier + result;
	return finite(result);
}

function rsi(values: number[], period: number): number | undefined {
	if (values.length <= period) return undefined;
	let gains = 0;
	let losses = 0;
	for (let i = 1; i <= period; i++) {
		const change = values[i] - values[i - 1];
		if (change >= 0) gains += change;
		else losses -= change;
	}
	let averageGain = gains / period;
	let averageLoss = losses / period;
	for (let i = period + 1; i < values.length; i++) {
		const change = values[i] - values[i - 1];
		averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
		averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
	}
	if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
	return finite(100 - 100 / (1 + averageGain / averageLoss));
}

function atr(candles: Candle[], period: number): number | undefined {
	if (candles.length <= period) return undefined;
	const ranges = candles.slice(1).map((candle, index) => {
		const previousClose = candles[index].close;
		return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
	});
	return sma(ranges, period);
}

function bollinger(values: number[], period: number): { middle?: number; upper?: number; lower?: number } {
	const middle = sma(values, period);
	if (middle === undefined) return {};
	const slice = values.slice(-period);
	const deviation = Math.sqrt(slice.reduce((sum, value) => sum + (value - middle) ** 2, 0) / period);
	return { middle, upper: middle + deviation * 2, lower: middle - deviation * 2 };
}

export function calculateIndicators(candles: Candle[]): IndicatorPoint[] {
	const closes: number[] = [];
	const fastMacd: number[] = [];
	const volumes: number[] = [];
	const points: IndicatorPoint[] = [];
	let previousMacdSignal: number | undefined;
	for (const candle of candles) {
		closes.push(candle.close);
		volumes.push(candle.volume);
		const fast = ema(closes, 12);
		const slow = ema(closes, 26);
		const macd = fast !== undefined && slow !== undefined ? fast - slow : undefined;
		if (macd !== undefined) fastMacd.push(macd);
		const macdSignal = ema(fastMacd, 9);
		if (macdSignal !== undefined) previousMacdSignal = macdSignal;
		const bands = bollinger(closes, 20);
		const volumeSma20 = sma(volumes, 20);
		points.push({
			timestamp: candle.timestamp,
			close: candle.close,
			ema20: ema(closes, 20),
			ema50: ema(closes, 50),
			rsi14: rsi(closes, 14),
			atr14: atr(candles.slice(0, points.length + 1), 14),
			macd,
			macdSignal: macdSignal ?? previousMacdSignal,
			macdHistogram: macd !== undefined && macdSignal !== undefined ? macd - macdSignal : undefined,
			bbMiddle: bands.middle,
			bbUpper: bands.upper,
			bbLower: bands.lower,
			volumeSma20,
			volumeRatio: volumeSma20 === undefined ? undefined : candle.volume / volumeSma20,
		});
	}
	return points;
}

export function latestIndicators(candles: Candle[]): IndicatorPoint | undefined {
	return calculateIndicators(candles).at(-1);
}
