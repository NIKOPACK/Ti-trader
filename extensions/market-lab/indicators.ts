export interface Candle {
	timestamp: number;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
}

export interface IndicatorPeriods {
	emaFast: number;
	emaSlow: number;
	rsi: number;
	atr: number;
	macdFast: number;
	macdSlow: number;
	macdSignal: number;
	bb: number;
	volumeSma: number;
}

export const DEFAULT_INDICATOR_PERIODS: IndicatorPeriods = {
	emaFast: 20,
	emaSlow: 50,
	rsi: 14,
	atr: 14,
	macdFast: 12,
	macdSlow: 26,
	macdSignal: 9,
	bb: 20,
	volumeSma: 20,
};

export interface IndicatorPoint {
	timestamp: number;
	close: number;
	emaFast?: number;
	emaSlow?: number;
	rsi?: number;
	atr?: number;
	macd?: number;
	macdSignal?: number;
	macdHistogram?: number;
	bbMiddle?: number;
	bbUpper?: number;
	bbLower?: number;
	volumeSma?: number;
	volumeRatio?: number;
	ema20?: number;
	ema50?: number;
	rsi14?: number;
	atr14?: number;
	volumeSma20?: number;
}

const MIN_PERIOD = 2;
const MAX_PERIOD = 200;

export function resolveIndicatorPeriods(input?: Partial<IndicatorPeriods>): IndicatorPeriods {
	const periods: IndicatorPeriods = { ...DEFAULT_INDICATOR_PERIODS };
	if (input) {
		for (const key of Object.keys(DEFAULT_INDICATOR_PERIODS) as Array<keyof IndicatorPeriods>) {
			const value = input[key];
			if (value !== undefined) periods[key] = value;
		}
	}
	for (const [key, value] of Object.entries(periods)) {
		if (!Number.isInteger(value) || value < MIN_PERIOD || value > MAX_PERIOD) {
			throw new Error(`Invalid ${key} period`);
		}
	}
	return periods;
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
		return Math.max(
			candle.high - candle.low,
			Math.abs(candle.high - previousClose),
			Math.abs(candle.low - previousClose),
		);
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

export function calculateIndicators(candles: Candle[], periods?: Partial<IndicatorPeriods>): IndicatorPoint[] {
	const p = resolveIndicatorPeriods(periods);
	const closes: number[] = [];
	const fastMacd: number[] = [];
	const volumes: number[] = [];
	const points: IndicatorPoint[] = [];
	let previousMacdSignal: number | undefined;
	for (const candle of candles) {
		closes.push(candle.close);
		volumes.push(candle.volume);
		const macdFast = ema(closes, p.macdFast);
		const macdSlow = ema(closes, p.macdSlow);
		const macd = macdFast !== undefined && macdSlow !== undefined ? macdFast - macdSlow : undefined;
		if (macd !== undefined) fastMacd.push(macd);
		const macdSignal = ema(fastMacd, p.macdSignal);
		if (macdSignal !== undefined) previousMacdSignal = macdSignal;
		const bands = bollinger(closes, p.bb);
		const volumeSma = sma(volumes, p.volumeSma);
		const emaFast = ema(closes, p.emaFast);
		const emaSlow = ema(closes, p.emaSlow);
		const rsiValue = rsi(closes, p.rsi);
		const atrValue = atr(candles.slice(0, points.length + 1), p.atr);
		points.push({
			timestamp: candle.timestamp,
			close: candle.close,
			emaFast,
			emaSlow,
			rsi: rsiValue,
			atr: atrValue,
			macd,
			macdSignal: macdSignal ?? previousMacdSignal,
			macdHistogram: macd !== undefined && macdSignal !== undefined ? macd - macdSignal : undefined,
			bbMiddle: bands.middle,
			bbUpper: bands.upper,
			bbLower: bands.lower,
			volumeSma,
			volumeRatio: volumeSma !== undefined && volumeSma > 0 ? candle.volume / volumeSma : undefined,
			ema20: p.emaFast === DEFAULT_INDICATOR_PERIODS.emaFast ? emaFast : undefined,
			ema50: p.emaSlow === DEFAULT_INDICATOR_PERIODS.emaSlow ? emaSlow : undefined,
			rsi14: p.rsi === DEFAULT_INDICATOR_PERIODS.rsi ? rsiValue : undefined,
			atr14: p.atr === DEFAULT_INDICATOR_PERIODS.atr ? atrValue : undefined,
			volumeSma20: p.volumeSma === DEFAULT_INDICATOR_PERIODS.volumeSma ? volumeSma : undefined,
		});
	}
	return points;
}
