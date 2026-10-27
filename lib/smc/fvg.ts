import type { Candle } from "../types";
import type { SmcThresholds } from "./config";

export type FvgDirection = "bullish" | "bearish";

export interface Fvg {
  direction: FvgDirection;
  index: number; // middle candle index
  top: number;
  bottom: number;
  /** distance in ATR from current price to nearest edge (0 if price inside gap) */
  atrDistance: number | null;
  filled: boolean;
}

/**
 * Detect FVGs over last fvgWindow candles: bullish if c1.high < c3.low, bearish if c1.low > c3.high.
 * Keeps only unfilled gaps (no later candle has traded through them). Returns nearest unfilled on each side within 3 ATR.
 * Uses only closed candles.
 */
export function detectFvg(
  candles: readonly Candle[],
  price: number,
  atr: number | null,
  thresholds: SmcThresholds,
): { bullish: Fvg | null; bearish: Fvg | null } {
  const n = candles.length;
  if (n < 3) return { bullish: null, bearish: null };
  const windowStart = Math.max(0, n - thresholds.fvgWindow);
  const triplets: Fvg[] = [];
  // Middle index i must be at least 1 and at most n-2, and i-1 >= windowStart means the triplet touches the window
  for (let i = Math.max(1, windowStart + 1); i <= n - 2; i++) {
    if (i - 1 < windowStart) continue;
    const c1 = candles[i - 1];
    const c3 = candles[i + 1];
    if (c1.high < c3.low) {
      triplets.push({ direction: "bullish", index: i, top: c3.low, bottom: c1.high, atrDistance: null, filled: false });
    } else if (c1.low > c3.high) {
      triplets.push({ direction: "bearish", index: i, top: c1.low, bottom: c3.high, atrDistance: null, filled: false });
    }
  }

  // Mark filled: any later candle j > i+1 whose range overlaps gap interior (strict)
  for (const g of triplets) {
    for (let j = g.index + 2; j < n; j++) {
      const c = candles[j];
      if (c.low < g.top && c.high > g.bottom) {
        g.filled = true;
        break;
      }
    }
  }

  const unfilled = triplets.filter((g) => !g.filled);
  const atrVal = atr !== null && atr > 0 ? atr : null;
  for (const g of unfilled) {
    if (atrVal !== null) {
      let dist: number;
      if (price >= g.top) dist = price - g.top;
      else if (price <= g.bottom) dist = g.bottom - price;
      else dist = 0; // price inside gap
      g.atrDistance = dist / atrVal;
    } else {
      g.atrDistance = null;
    }
  }

  const maxAtr = thresholds.fvgMaxAtr;
  const inRange = (g: Fvg) => atrVal === null || g.atrDistance === null || g.atrDistance <= maxAtr;

  const bullishCandidates = unfilled.filter((g) => g.direction === "bullish" && inRange(g));
  const bearishCandidates = unfilled.filter((g) => g.direction === "bearish" && inRange(g));

  // Nearest = smallest ATR distance; tie-break most recent (highest index)
  bullishCandidates.sort((a, b) => (a.atrDistance ?? 999) - (b.atrDistance ?? 999) || b.index - a.index);
  bearishCandidates.sort((a, b) => (a.atrDistance ?? 999) - (b.atrDistance ?? 999) || b.index - a.index);

  return {
    bullish: bullishCandidates[0] ?? null,
    bearish: bearishCandidates[0] ?? null,
  };
}

/** Returns true if the FVG interval overlaps the open interval (entry, tp1) */
export function fvgBetween(fvg: Fvg, entry: number, tp1: number): boolean {
  const low = Math.min(entry, tp1);
  const high = Math.max(entry, tp1);
  // Strict overlap: gap [bottom, top] overlaps (low, high)
  return fvg.bottom < high && fvg.top > low && Math.max(fvg.bottom, low) < Math.min(fvg.top, high);
}
