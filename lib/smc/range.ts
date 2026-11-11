import { SWING_STRENGTH } from "../config";
import { findSwings } from "../indicators";
import type { Candle, Timeframe } from "../types";
import type { SmcThresholds } from "./config";

export type Zone = "discount" | "premium" | "equilibrium" | "unavailable";

export interface DealingRange {
  high: number;
  low: number;
  pricePositionPct: number;
  zone: Zone;
}

/**
 * Latest confirmed swing high/low on the setup timeframe give the dealing range.
 * Uses only closed candles (input is assumed closed). Returns unavailable if
 * fewer than one high and one low are confirmed.
 */
export function dealingRange(
  candles: readonly Candle[],
  timeframe: Timeframe,
  price: number,
  thresholds: SmcThresholds,
): DealingRange | null {
  if (candles.length === 0) return null;
  const strength = SWING_STRENGTH[timeframe] ?? 3;
  const swings = findSwings(candles, strength);
  const highs = swings.filter((s) => s.type === "high");
  const lows = swings.filter((s) => s.type === "low");
  if (highs.length === 0 || lows.length === 0) return null;
  const high = highs[highs.length - 1].price;
  const low = lows[lows.length - 1].price;
  if (!(high > low)) return null;
  const pct = ((price - low) / (high - low)) * 100;
  let zone: Zone;
  if (pct <= thresholds.zoneDiscount) zone = "discount";
  else if (pct >= thresholds.zonePremium) zone = "premium";
  else zone = "equilibrium";
  return { high, low, pricePositionPct: pct, zone };
}
