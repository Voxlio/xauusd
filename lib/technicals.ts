/**
 * Turns raw candles into compact per-timeframe snapshots. Pure and testable:
 * see tests/technicals.test.ts.
 */
import { MIN_CANDLES, MODE_TIMEFRAMES, ROLES, SWING_STRENGTH } from "./config";
import {
  atr,
  classifyStructure,
  classifyTrend,
  clusterLevels,
  ema,
  findSwings,
  lastFinite,
  macd,
  rsi,
  supportResistance,
} from "./indicators";
import { finiteOrNull, round, roundOrNull } from "./num";
import type {
  Candle,
  MacdValue,
  Mode,
  TechnicalSummary,
  Timeframe,
  TimeframeRole,
  TimeframeSnapshot,
} from "./types";

export class InsufficientDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientDataError";
  }
}

const SWING_LOOKBACK_BARS = 150;
const SWINGS_REPORTED = 8;
const SLOPE_LOOKBACK = 5;
const LEVEL_TOLERANCE_ATR = 0.35;
/** Swing highs/lows closer than this many ATRs count as equal for structure. */
const STRUCTURE_TOLERANCE_ATR = 0.2;

export function analyzeTimeframe(
  candles: readonly Candle[],
  timeframe: Timeframe,
  role: TimeframeRole,
): TimeframeSnapshot {
  if (candles.length < MIN_CANDLES) {
    throw new InsufficientDataError(
      `${timeframe}: need at least ${MIN_CANDLES} candles, received ${candles.length}`,
    );
  }
  const closes = candles.map((c) => c.close);
  const last = candles[candles.length - 1];
  const n = candles.length;

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const rsi14 = rsi(closes, 14);
  const macdSeries = macd(closes, 12, 26, 9);
  const atr14 = atr(candles, 14);
  const atrNow = lastFinite(atr14);

  const strength = SWING_STRENGTH[timeframe];
  const windowStart = Math.max(0, n - SWING_LOOKBACK_BARS);
  const swings = findSwings(candles, strength).filter((s) => s.index >= windowStart);
  const structure = classifyStructure(swings, (atrNow ?? 0) * STRUCTURE_TOLERANCE_ATR);

  const { trend, score } = classifyTrend({
    close: last.close,
    ema20: finiteOrNull(ema20[n - 1]),
    ema50: finiteOrNull(ema50[n - 1]),
    ema200: finiteOrNull(ema200[n - 1]),
    ema50Prev: finiteOrNull(ema50[n - 1 - SLOPE_LOOKBACK]),
    structure,
    atr: atrNow,
  });

  const newestFirst = (type: "high" | "low") =>
    swings
      .filter((s) => s.type === type)
      .map((s) => round(s.price))
      .reverse()
      .slice(0, SWINGS_REPORTED);

  const tail = candles.slice(-(strength + 1));
  const recentHigh = Math.max(...tail.map((c) => c.high));
  const recentLow = Math.min(...tail.map((c) => c.low));

  const tolerance = atrNow !== null && atrNow > 0 ? atrNow * LEVEL_TOLERANCE_ATR : last.close * 0.001;
  const levels = clusterLevels(
    swings.map((s) => s.price),
    tolerance,
  );
  const { supports, resistances } = supportResistance(levels, last.close, 3);

  const hist = macdSeries.histogram;
  const macdValue: MacdValue | null =
    Number.isFinite(hist[n - 1]) && Number.isFinite(hist[n - 2])
      ? {
          macd: round(macdSeries.macd[n - 1], 3),
          signal: round(macdSeries.signal[n - 1], 3),
          histogram: round(hist[n - 1], 3),
          histogramPrev: round(hist[n - 2], 3),
        }
      : null;

  return {
    timeframe,
    role,
    bars: n,
    lastTime: last.time,
    close: round(last.close),
    ema20: roundOrNull(ema20[n - 1]),
    ema50: roundOrNull(ema50[n - 1]),
    ema200: roundOrNull(ema200[n - 1]),
    rsi14: roundOrNull(rsi14[n - 1], 1),
    macd: macdValue,
    atr14: roundOrNull(atrNow),
    trend,
    trendScore: score,
    structure,
    swingHighs: newestFirst("high"),
    swingLows: newestFirst("low"),
    recentHigh: round(recentHigh),
    recentLow: round(recentLow),
    supports: supports.map((l) => ({ price: round(l.price), touches: l.touches })),
    resistances: resistances.map((l) => ({ price: round(l.price), touches: l.touches })),
    changePct20: n > 20 ? round((last.close / candles[n - 21].close - 1) * 100) : null,
  };
}

export interface TechnicalsResult {
  summary: TechnicalSummary;
  warnings: string[];
}

/**
 * Builds the multi-timeframe summary. The setup timeframe is mandatory (its ATR
 * drives every risk rule); trigger and trend timeframes are optional.
 */
export function buildTechnicals(
  mode: Mode,
  candlesByTimeframe: Partial<Record<Timeframe, readonly Candle[]>>,
): TechnicalsResult {
  const timeframes = MODE_TIMEFRAMES[mode];
  const setupTimeframe = timeframes[1];
  const warnings: string[] = [];
  const snapshots: TimeframeSnapshot[] = [];

  timeframes.forEach((tf, i) => {
    const candles = candlesByTimeframe[tf];
    const role = ROLES[i];
    if (!candles || candles.length === 0) {
      if (tf === setupTimeframe) {
        throw new InsufficientDataError(`No ${tf} candles available for the setup timeframe`);
      }
      warnings.push(`${tf} data unavailable; analysis uses the remaining timeframes.`);
      return;
    }
    try {
      snapshots.push(analyzeTimeframe(candles, tf, role));
    } catch (error) {
      if (tf === setupTimeframe || !(error instanceof InsufficientDataError)) throw error;
      warnings.push(`${error.message}; timeframe skipped.`);
    }
  });

  const setup = snapshots.find((s) => s.timeframe === setupTimeframe);
  if (!setup || setup.atr14 === null || setup.atr14 <= 0) {
    throw new InsufficientDataError(`ATR(14) on ${setupTimeframe} could not be computed`);
  }
  const trigger = snapshots.find((s) => s.role === "trigger");
  const priceSource = trigger ?? setup;

  const alignment = { up: 0, down: 0, range: 0 };
  for (const s of snapshots) alignment[s.trend] += 1;

  return {
    summary: {
      mode,
      price: priceSource.close,
      priceTime: priceSource.lastTime,
      priceTimeframe: priceSource.timeframe,
      setupTimeframe,
      atr: setup.atr14,
      timeframes: snapshots,
      alignment,
    },
    warnings,
  };
}
