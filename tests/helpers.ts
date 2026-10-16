/** Deterministic candle builders shared by the test files. */
import type { Candle } from "../lib/types";

export const T0 = Date.UTC(2026, 9, 12, 0, 0, 0); // Mon 12 Oct 2026 00:00 UTC

/** Builds candles from closes: open = previous close, wicks of `wick` beyond the body. */
export function candlesFromCloses(closes: readonly number[], stepMs = 3_600_000, wick = 0.5, start = T0): Candle[] {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    return {
      time: start + i * stepMs,
      open,
      high: Math.max(open, close) + wick,
      low: Math.min(open, close) - wick,
      close,
    };
  });
}

/** Builds candles from explicit [high, low] pairs (open/close at the midpoint). */
export function candlesFromHighLow(pairs: ReadonlyArray<readonly [number, number]>, stepMs = 3_600_000): Candle[] {
  return pairs.map(([high, low], i) => {
    const mid = (high + low) / 2;
    return { time: T0 + i * stepMs, open: mid, high, low, close: mid };
  });
}

/** Zig-zag series with drift: close_i = start + drift*i + amplitude*sin(i/period). */
export function wave(n: number, start: number, drift: number, amplitude: number, period = 4): number[] {
  return Array.from({ length: n }, (_, i) => start + drift * i + amplitude * Math.sin(i / period));
}

export function approx(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) <= tolerance;
}
