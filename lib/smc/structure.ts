import { SWING_STRENGTH } from "../config";
import { classifyStructure, findSwings } from "../indicators";
import type { Candle, Timeframe } from "../types";

export type StructureEventType = "BOS" | "CHoCH";

export interface StructureEvent {
  type: StructureEventType;
  /** "bullish" = price broke above high, "bearish" = broke below low */
  direction: "bullish" | "bearish";
  price: number;
  /** candles ago from the last candle (0 = last candle closed beyond) */
  candlesAgo: number;
  index: number;
}

/**
 * BOS = candle CLOSE beyond latest confirmed swing high/low in direction of current trend.
 * CHoCH = first close against prevailing structure (uptrend -> bearish CHoCH = close below latest swing low; downtrend -> bullish CHoCH = close above latest swing high).
 *
 * Uses only CLOSED candles. Returns the most recent BOS and CHoCH on the setup timeframe, or null.
 */
export function detectBosAndChoch(
  candles: readonly Candle[],
  timeframe: Timeframe,
  atr: number | null,
): { bos: StructureEvent | null; choch: StructureEvent | null } {
  if (candles.length < 10) return { bos: null, choch: null };
  const strength = SWING_STRENGTH[timeframe] ?? 3;
  const swings = findSwings(candles, strength);
  if (swings.length < 2) return { bos: null, choch: null };

  // Tolerance for structure classification (same as technicals.ts)
  const tolerance = atr !== null && atr > 0 ? atr * 0.2 : 0;
  const structure = classifyStructure(swings, tolerance);

  const highs = swings.filter((s) => s.type === "high");
  const lows = swings.filter((s) => s.type === "low");
  if (highs.length === 0 || lows.length === 0) return { bos: null, choch: null };

  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];
  const n = candles.length;
  const lastIndex = n - 1;

  // Search from newest to oldest for first close beyond swing level
  let bos: StructureEvent | null = null;
  let choch: StructureEvent | null = null;

  // For BOS: need close beyond last swing in trend direction. For CHoCH: close against trend.
  // Determine expected directions
  const isUptrend = structure === "higher-highs-lows";
  const isDowntrend = structure === "lower-highs-lows";

  // Scan candles from newest backwards (only after the swing was confirmed)
  // A swing at index i is confirmed at i+strength, so only candles after that can BOS/CHoCH it.
  // Simplification: only consider closes after the swing index + strength
  const earliestBosIndex = Math.max(lastHigh.index + strength, lastLow.index + strength);

  // Find most recent event: iterate from last candle backwards
  for (let i = lastIndex; i >= earliestBosIndex && i >= 0; i--) {
    const close = candles[i].close;
    const candlesAgo = lastIndex - i;

    // Check CHoCH first (against trend) - higher priority for detection
    if (!choch) {
      if (isUptrend) {
        // Bearish CHoCH: close below last swing low in uptrend
        if (close < lastLow.price) {
          choch = { type: "CHoCH", direction: "bearish", price: lastLow.price, candlesAgo, index: i };
        }
      } else if (isDowntrend) {
        // Bullish CHoCH: close above last swing high in downtrend
        if (close > lastHigh.price) {
          choch = { type: "CHoCH", direction: "bullish", price: lastHigh.price, candlesAgo, index: i };
        }
      }
      // In mixed/insufficient, no CHoCH
    }

    if (!bos) {
      if (isUptrend) {
        if (close > lastHigh.price) {
          bos = { type: "BOS", direction: "bullish", price: lastHigh.price, candlesAgo, index: i };
        }
      } else if (isDowntrend) {
        if (close < lastLow.price) {
          bos = { type: "BOS", direction: "bearish", price: lastLow.price, candlesAgo, index: i };
        }
      } else {
        // Mixed/insufficient: report any BOS regardless of trend
        if (close > lastHigh.price) {
          bos = { type: "BOS", direction: "bullish", price: lastHigh.price, candlesAgo, index: i };
        } else if (close < lastLow.price) {
          bos = { type: "BOS", direction: "bearish", price: lastLow.price, candlesAgo, index: i };
        }
      }
    }

    if (bos && choch) break;
    // If we found CHoCH in downtrend but also BOS bullish, they are mutually exclusive? Keep both if exist, but prefer most recent
    if (bos && isUptrend && choch) break;
    if (bos && isDowntrend && choch) break;
  }

  // For mixed structure, if we found both but one is older, we still return most recent of each; that's fine.
  // However ensure BOS is in-trend only when structure is directional. For mixed, BOS could be either side; keep it.
  // For directional structure, ensure BOS direction matches trend, CHoCH opposite.
  if (isUptrend && bos && bos.direction !== "bullish") bos = null;
  if (isDowntrend && bos && bos.direction !== "bearish") bos = null;
  if (isUptrend && choch && choch.direction !== "bearish") choch = null;
  if (isDowntrend && choch && choch.direction !== "bullish") choch = null;

  return { bos, choch };
}
