import { SWING_STRENGTH } from "../config";
import { findSwings } from "../indicators";
import type { Candle, Timeframe } from "../types";
import type { SmcThresholds } from "./config";

export interface LiquiditySweep {
  direction: "highs" | "lows";
  /** latest swing price that was swept */
  sweptPrice: number;
  candlesAgo: number;
  index: number;
}

/**
 * Within last sweepWindow candles, a wick that pierces latest swing high/low by more than sweepAtrMult * ATR
 * and then CLOSES back inside. Returns most recent such sweep, or null.
 * Uses only closed candles.
 */
export function detectSweep(
  candles: readonly Candle[],
  timeframe: Timeframe,
  atr: number | null,
  thresholds: SmcThresholds,
): LiquiditySweep | null {
  if (candles.length < 10) return null;
  if (atr === null || atr <= 0) return null;
  const strength = SWING_STRENGTH[timeframe] ?? 3;
  const swings = findSwings(candles, strength);
  const highs = swings.filter((s) => s.type === "high");
  const lows = swings.filter((s) => s.type === "low");
  if (highs.length === 0 || lows.length === 0) return null;
  const lastHigh = highs[highs.length - 1].price;
  const lastLow = lows[lows.length - 1].price;
  const threshold = thresholds.sweepAtrMult * atr;
  const n = candles.length;
  const start = Math.max(0, n - thresholds.sweepWindow);
  // Search newest first
  for (let i = n - 1; i >= start; i--) {
    const c = candles[i];
    const candlesAgo = n - 1 - i;
    // swept highs: high exceeds swing high by > threshold and close back inside (close < swing high)
    if (c.high > lastHigh + threshold && c.close < lastHigh) {
      return { direction: "highs", sweptPrice: lastHigh, candlesAgo, index: i };
    }
    // swept lows: low below swing low by > threshold and close back inside (close > swing low)
    if (c.low < lastLow - threshold && c.close > lastLow) {
      return { direction: "lows", sweptPrice: lastLow, candlesAgo, index: i };
    }
  }
  return null;
}
