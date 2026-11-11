import { sma } from "../indicators";
import type { Candle } from "../types";
import type { SmcThresholds } from "./config";

export type SmaSide = "above" | "below" | "unavailable";
export type CrossType = "golden" | "death" | null;

export interface SmaContext {
  sma50: number | null;
  sma200: number | null;
  priceVsSma50: SmaSide;
  priceVsSma200: SmaSide;
  cross: CrossType;
  crossCandlesAgo: number | null;
  available: boolean;
}

/**
 * SMA50/200 on the trend timeframe. Uses only closed candles.
 * If fewer candles than needed, marks that item unavailable and skips silently.
 */
export function smaContext(
  candles: readonly Candle[],
  price: number,
  thresholds: SmcThresholds,
): SmaContext {
  const closes = candles.map((c) => c.close);
  const n = closes.length;

  let sma50: number | null = null;
  let sma200: number | null = null;
  let priceVsSma50: SmaSide = "unavailable";
  let priceVsSma200: SmaSide = "unavailable";

  if (n >= 50) {
    const s50 = sma(closes, 50);
    const v = s50[n - 1];
    if (Number.isFinite(v)) {
      sma50 = v;
      priceVsSma50 = price > v ? "above" : price < v ? "below" : "above";
      if (price === v) priceVsSma50 = "above";
    }
  }

  if (n >= 200) {
    const s200 = sma(closes, 200);
    const v = s200[n - 1];
    if (Number.isFinite(v)) {
      sma200 = v;
      priceVsSma200 = price > v ? "above" : price < v ? "below" : "above";
      if (price === v) priceVsSma200 = "above";
    }
  }

  let cross: CrossType = null;
  let crossCandlesAgo: number | null = null;

  if (n >= 200) {
    const s50 = sma(closes, 50);
    const s200 = sma(closes, 200);
    const windowStart = Math.max(200 - 1, n - thresholds.crossWindow);
    // Search from newest backwards for most recent cross within window (inclusive of windowStart)
    for (let i = n - 1; i >= windowStart && i > 0; i--) {
      const aNow = s50[i];
      const bNow = s200[i];
      const aPrev = s50[i - 1];
      const bPrev = s200[i - 1];
      if (!Number.isFinite(aNow) || !Number.isFinite(bNow) || !Number.isFinite(aPrev) || !Number.isFinite(bPrev)) continue;
      if (aNow > bNow && aPrev <= bPrev) {
        cross = "golden";
        crossCandlesAgo = n - 1 - i;
        break;
      }
      if (aNow < bNow && aPrev >= bPrev) {
        cross = "death";
        crossCandlesAgo = n - 1 - i;
        break;
      }
    }
  }

  const available = sma50 !== null || sma200 !== null;

  return { sma50, sma200, priceVsSma50, priceVsSma200, cross, crossCandlesAgo, available };
}
