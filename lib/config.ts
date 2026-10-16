import type { Mode, Timeframe, TimeframeRole } from "./types";

export const SYMBOL = "XAU/USD" as const;

/** Timeframes per mode, ordered trigger -> setup -> trend. */
export const MODE_TIMEFRAMES: Record<Mode, readonly [Timeframe, Timeframe, Timeframe]> = {
  day: ["M15", "H1", "H4"],
  swing: ["H4", "D1", "W1"],
};

export const ROLES: readonly [TimeframeRole, TimeframeRole, TimeframeRole] = ["trigger", "setup", "trend"];

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  M15: 15 * 60_000,
  H1: 60 * 60_000,
  H4: 4 * 60 * 60_000,
  D1: 24 * 60 * 60_000,
  W1: 7 * 24 * 60 * 60_000,
};

/** Pivot strength (bars each side) used for swing detection. */
export const SWING_STRENGTH: Record<Timeframe, number> = {
  M15: 3,
  H1: 3,
  H4: 3,
  D1: 2,
  W1: 2,
};

/** Candles requested per timeframe (enough warm-up for EMA 200). */
export const CANDLE_COUNT = 500;

/** Minimum candles needed to analyse a timeframe (MACD 26+9 plus margin). */
export const MIN_CANDLES = 60;

/** Risk and validation rules. Every distance is in ATR(14) of the setup timeframe. */
export const RULES = {
  entryMaxAtr: 0.5,
  stopMinAtr: 1.0,
  stopMaxAtr: 2.5,
  swingBufferAtr: 0.1,
  tp1MinR: 1.5,
  tp2MinR: 2.5,
  tp2GapR: 0.5,
  tp1MaxR: 6,
  tp2MaxR: 10,
  newsBlockAheadMs: 3 * 60 * 60_000,
  newsBlockBehindMs: 15 * 60_000,
  newsWindowMs: 48 * 60 * 60_000,
  minConfidence: 40,
  /** If the newest trigger candle is older than this, the market is treated as closed. */
  marketClosedAfterMs: 90 * 60_000,
} as const;

/** Time budget for one request (Vercel Hobby functions should finish well under 10s). */
export const BUDGET = {
  totalMs: 9_000,
  upstreamTimeoutMs: 3_500,
  aiMaxMs: 6_000,
  aiMinMs: 2_000,
  staleMaxMs: 15 * 60_000,
  calendarTtlMs: 5 * 60_000,
  /** Candles are never cached longer than this, whatever CACHE_TTL_SECONDS says. */
  candleTtlMaxMs: 120_000,
} as const;

export const DISCLAIMER = "Educational use only. Not financial advice. Test on a demo account.";
