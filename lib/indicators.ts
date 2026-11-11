/**
 * Pure indicator math. No I/O, no dependencies — every function is deterministic
 * and unit-tested in tests/indicators.test.ts.
 *
 * Conventions:
 * - Series are arrays aligned with the input; positions without enough data are NaN.
 * - EMA is seeded with the SMA of the first `period` values (TradingView/TA-Lib style).
 * - RSI and ATR use Wilder's smoothing (RMA) seeded with a simple average.
 */
import type { Candle, PriceLevel, Structure, SwingPoint, Trend } from "./types";

function assertPeriod(period: number, name = "period"): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`${name} must be a positive integer, received ${period}`);
  }
}

export function lastFinite(series: readonly number[]): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    if (Number.isFinite(series[i])) return series[i];
  }
  return null;
}

export function sma(values: readonly number[], period: number): number[] {
  assertPeriod(period);
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: readonly number[], period: number): number[] {
  assertPeriod(period);
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's moving average (RMA), seeded with the SMA of the first `period` values. */
export function rma(values: readonly number[], period: number): number[] {
  assertPeriod(period);
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function rsi(closes: readonly number[], period = 14): number[] {
  assertPeriod(period);
  const out = new Array<number>(closes.length).fill(NaN);
  if (closes.length <= period) return out;

  const toRsi = (gain: number, loss: number): number => {
    if (loss === 0) return gain === 0 ? 50 : 100;
    return 100 - 100 / (1 + gain / loss);
  };

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gainSum += change;
    else lossSum -= change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = toRsi(avgGain, avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
}

export interface MacdSeries {
  macd: number[];
  signal: number[];
  histogram: number[];
}

export function macd(closes: readonly number[], fast = 12, slow = 26, signalPeriod = 9): MacdSeries {
  assertPeriod(fast, "fast");
  assertPeriod(slow, "slow");
  assertPeriod(signalPeriod, "signal");
  if (fast >= slow) throw new RangeError("fast period must be shorter than slow period");

  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const line = closes.map((_, i) =>
    Number.isFinite(fastEma[i]) && Number.isFinite(slowEma[i]) ? fastEma[i] - slowEma[i] : NaN,
  );

  const signal = new Array<number>(closes.length).fill(NaN);
  const firstValid = slow - 1;
  if (closes.length > firstValid) {
    const signalPart = ema(line.slice(firstValid), signalPeriod);
    for (let i = 0; i < signalPart.length; i++) signal[firstValid + i] = signalPart[i];
  }
  const histogram = line.map((value, i) =>
    Number.isFinite(value) && Number.isFinite(signal[i]) ? value - signal[i] : NaN,
  );
  return { macd: line, signal, histogram };
}

export function trueRange(candles: readonly Candle[]): number[] {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
}

export function atr(candles: readonly Candle[], period = 14): number[] {
  return rma(trueRange(candles), period);
}

/**
 * Fractal swing points. A swing high needs `strength` strictly lower highs on
 * the left and `strength` lower-or-equal highs on the right (so equal highs are
 * reported once). The last `strength` bars can never be confirmed.
 */
export function findSwings(candles: readonly Candle[], strength = 3): SwingPoint[] {
  assertPeriod(strength, "strength");
  const swings: SwingPoint[] = [];
  for (let i = strength; i < candles.length - strength; i++) {
    const { high, low } = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= strength; j++) {
      const left = candles[i - j];
      const right = candles[i + j];
      if (!(high > left.high && high >= right.high)) isHigh = false;
      if (!(low < left.low && low <= right.low)) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) swings.push({ index: i, time: candles[i].time, price: high, type: "high" });
    if (isLow) swings.push({ index: i, time: candles[i].time, price: low, type: "low" });
  }
  return swings;
}

/**
 * Market structure from the last two confirmed swing highs and lows. Swings
 * within `tolerance` of each other count as equal (so noise is not a trend).
 */
export function classifyStructure(swings: readonly SwingPoint[], tolerance = 0): Structure {
  const highs = swings.filter((s) => s.type === "high");
  const lows = swings.filter((s) => s.type === "low");
  if (highs.length < 2 || lows.length < 2) return "insufficient";
  const [h2, h1] = highs.slice(-2);
  const [l2, l1] = lows.slice(-2);
  if (h1.price > h2.price + tolerance && l1.price > l2.price + tolerance) return "higher-highs-lows";
  if (h1.price < h2.price - tolerance && l1.price < l2.price - tolerance) return "lower-highs-lows";
  return "mixed";
}

/**
 * Groups swing prices into support/resistance zones. Prices closer than
 * `tolerance` to the running cluster average are merged; touches counts the
 * swings in each zone.
 */
export function clusterLevels(prices: readonly number[], tolerance: number): PriceLevel[] {
  if (!(tolerance > 0)) throw new RangeError("tolerance must be positive");
  const sorted = prices.filter(Number.isFinite).slice().sort((a, b) => a - b);
  const levels: PriceLevel[] = [];
  let bucket: number[] = [];
  const flush = () => {
    if (bucket.length === 0) return;
    const avg = bucket.reduce((s, p) => s + p, 0) / bucket.length;
    levels.push({ price: avg, touches: bucket.length });
    bucket = [];
  };
  for (const price of sorted) {
    if (bucket.length === 0) {
      bucket.push(price);
      continue;
    }
    const avg = bucket.reduce((s, p) => s + p, 0) / bucket.length;
    if (price - avg <= tolerance) bucket.push(price);
    else {
      flush();
      bucket.push(price);
    }
  }
  flush();
  return levels;
}

/** Splits zones into supports below and resistances above price, nearest first. */
export function supportResistance(
  levels: readonly PriceLevel[],
  price: number,
  limit = 3,
): { supports: PriceLevel[]; resistances: PriceLevel[] } {
  const supports = levels
    .filter((l) => l.price < price)
    .sort((a, b) => b.price - a.price)
    .slice(0, limit);
  const resistances = levels
    .filter((l) => l.price > price)
    .sort((a, b) => a.price - b.price)
    .slice(0, limit);
  return { supports, resistances };
}

export interface TrendInput {
  close: number;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  /** EMA50 value `slopeLookback` bars ago, used for slope direction. */
  ema50Prev: number | null;
  structure: Structure;
  /** When given, comparisons closer than a fraction of ATR vote neutral. */
  atr?: number | null;
}

/** Comparisons within this many ATRs are treated as "flat". */
export const TREND_BAND_ATR = 0.2;
export const SLOPE_BAND_ATR = 0.1;

/**
 * Trend vote: each available condition adds +1 (bullish), -1 (bearish) or 0
 * (within the ATR neutral band). Score is normalised to -100..100;
 * |score| > 50 (a clear majority) marks a trend, otherwise range.
 */
export function classifyTrend(input: TrendInput): { trend: Trend; score: number } {
  const { close, ema20, ema50, ema200, ema50Prev, structure } = input;
  const atrValue = input.atr && input.atr > 0 ? input.atr : 0;
  const band = atrValue * TREND_BAND_ATR;
  const slopeBand = atrValue * SLOPE_BAND_ATR;
  const votes: number[] = [];
  const compare = (a: number, b: number, tolerance: number) =>
    votes.push(a > b + tolerance ? 1 : a < b - tolerance ? -1 : 0);

  if (ema20 !== null) compare(close, ema20, band);
  if (ema20 !== null && ema50 !== null) compare(ema20, ema50, band);
  if (ema50 !== null && ema200 !== null) compare(ema50, ema200, band);
  if (ema200 !== null) compare(close, ema200, band);
  if (ema50 !== null && ema50Prev !== null) compare(ema50, ema50Prev, slopeBand);
  if (structure !== "insufficient") {
    votes.push(structure === "higher-highs-lows" ? 1 : structure === "lower-highs-lows" ? -1 : 0);
  }

  if (votes.length === 0) return { trend: "range", score: 0 };
  const score = Math.round((votes.reduce((s, v) => s + v, 0) / votes.length) * 100);
  const trend: Trend = score > 50 ? "up" : score < -50 ? "down" : "range";
  return { trend, score };
}
