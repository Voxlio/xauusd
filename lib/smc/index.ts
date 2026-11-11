import { atr } from "../indicators";
import type { Candle, Mode, Timeframe } from "../types";
import { MODE_TIMEFRAMES } from "../config";
import { getSmcPenalties, getSmcThresholds } from "./config";
import { dealingRange, type DealingRange } from "./range";
import { detectBosAndChoch, type StructureEvent } from "./structure";
import { detectSweep, type LiquiditySweep } from "./sweep";
import { detectFvg, type Fvg } from "./fvg";
import { smaContext, type SmaContext } from "./sma";

export type { DealingRange } from "./range";
export type { StructureEvent } from "./structure";
export type { LiquiditySweep } from "./sweep";
export type { Fvg } from "./fvg";
export type { SmaContext } from "./sma";

export interface SmcStructureSnapshot {
  bos: StructureEvent | null;
  choch: StructureEvent | null;
}

export interface SmcFvgSnapshot {
  bullish: Fvg | null;
  bearish: Fvg | null;
}

export interface SmcSnapshot {
  available: boolean;
  setupTimeframe: Timeframe;
  trendTimeframe: Timeframe;
  dealingRange: DealingRange | null;
  /** zone string duplicated for convenience */
  zone: DealingRange["zone"] | "unavailable";
  pricePositionPct: number | null;
  structure: SmcStructureSnapshot;
  sweep: LiquiditySweep | null;
  fvgs: SmcFvgSnapshot;
  sma: SmaContext;
  atr: number | null;
  /** true when SMC_ENABLED=false */
  disabled: boolean;
}

/** Build SMC snapshot from existing candles. Uses only closed candles. No I/O. */
export function buildSmcSnapshot(
  mode: Mode,
  candlesByTimeframe: Partial<Record<Timeframe, readonly Candle[]>>,
  price: number,
): SmcSnapshot {
  const penalties = getSmcPenalties();
  const thresholds = getSmcThresholds();
  if (!penalties.enabled) {
    const timeframes = MODE_TIMEFRAMES[mode];
    return {
      available: false,
      setupTimeframe: timeframes[1],
      trendTimeframe: timeframes[2],
      dealingRange: null,
      zone: "unavailable",
      pricePositionPct: null,
      structure: { bos: null, choch: null },
      sweep: null,
      fvgs: { bullish: null, bearish: null },
      sma: { sma50: null, sma200: null, priceVsSma50: "unavailable", priceVsSma200: "unavailable", cross: null, crossCandlesAgo: null, available: false },
      atr: null,
      disabled: true,
    };
  }

  const timeframes = MODE_TIMEFRAMES[mode];
  const setupTf = timeframes[1];
  const trendTf = timeframes[2];
  // Swing mode: W1 if available else D1 for SMA fallback
  let smaTf: Timeframe = trendTf;
  let smaCandles: readonly Candle[] | undefined = candlesByTimeframe[trendTf];
  if (mode === "swing" && (!smaCandles || smaCandles.length < 50)) {
    const fallback: Timeframe = "D1";
    const fb = candlesByTimeframe[fallback];
    if (fb && fb.length >= 50) {
      smaTf = fallback;
      smaCandles = fb;
    }
  }

  const setupCandles = candlesByTimeframe[setupTf];
  const trendCandles = candlesByTimeframe[trendTf];
  void trendCandles; // not used directly except maybe fallback

  if (!setupCandles || setupCandles.length < 10) {
    const smaCtx = smaCandles ? smaContext(smaCandles, price, thresholds) : { sma50: null, sma200: null, priceVsSma50: "unavailable" as const, priceVsSma200: "unavailable" as const, cross: null, crossCandlesAgo: null, available: false };
    return {
      available: false,
      setupTimeframe: setupTf,
      trendTimeframe: smaTf,
      dealingRange: null,
      zone: "unavailable",
      pricePositionPct: null,
      structure: { bos: null, choch: null },
      sweep: null,
      fvgs: { bullish: null, bearish: null },
      sma: smaCtx,
      atr: null,
      disabled: false,
    };
  }

  const atrSeries = atr(setupCandles as readonly import("../types").Candle[], 14);
  let atrVal: number | null = null;
  for (let i = atrSeries.length - 1; i >= 0; i--) {
    if (Number.isFinite(atrSeries[i])) { atrVal = atrSeries[i]; break; }
  }

  const dr = dealingRange(setupCandles, setupTf, price, thresholds);
  const bosChoch = detectBosAndChoch(setupCandles, setupTf, atrVal);
  const sweep = detectSweep(setupCandles, setupTf, atrVal, thresholds);
  const fvgs = detectFvg(setupCandles, price, atrVal, thresholds);
  const sma = smaCandles ? smaContext(smaCandles, price, thresholds) : { sma50: null, sma200: null, priceVsSma50: "unavailable" as const, priceVsSma200: "unavailable" as const, cross: null, crossCandlesAgo: null, available: false };

  const available = dr !== null;
  return {
    available,
    setupTimeframe: setupTf,
    trendTimeframe: smaTf,
    dealingRange: dr,
    zone: dr ? dr.zone : "unavailable",
    pricePositionPct: dr ? dr.pricePositionPct : null,
    structure: bosChoch,
    sweep,
    fvgs,
    sma,
    atr: atrVal,
    disabled: false,
  };
}

/** Compact structure block sent to the AI (and shown on card) */
export function smcToAiBlock(snapshot: SmcSnapshot): Record<string, unknown> | null {
  if (!snapshot.available || snapshot.disabled) return null;
  return {
    setupTimeframe: snapshot.setupTimeframe,
    trendTimeframe: snapshot.trendTimeframe,
    dealingRange: snapshot.dealingRange ? { high: Math.round(snapshot.dealingRange.high * 100) / 100, low: Math.round(snapshot.dealingRange.low * 100) / 100, pricePositionPct: Math.round(snapshot.pricePositionPct! * 10) / 10, zone: snapshot.zone } : null,
    bos: snapshot.structure.bos ? { direction: snapshot.structure.bos.direction, price: Math.round(snapshot.structure.bos.price * 100) / 100, candlesAgo: snapshot.structure.bos.candlesAgo } : null,
    choch: snapshot.structure.choch ? { direction: snapshot.structure.choch.direction, price: Math.round(snapshot.structure.choch.price * 100) / 100, candlesAgo: snapshot.structure.choch.candlesAgo } : null,
    sweep: snapshot.sweep ? { direction: snapshot.sweep.direction, candlesAgo: snapshot.sweep.candlesAgo } : null,
    fvgs: {
      bullish: snapshot.fvgs.bullish ? { top: Math.round(snapshot.fvgs.bullish.top * 100) / 100, bottom: Math.round(snapshot.fvgs.bullish.bottom * 100) / 100, atrDistance: snapshot.fvgs.bullish.atrDistance !== null ? Math.round(snapshot.fvgs.bullish.atrDistance * 10) / 10 : null } : null,
      bearish: snapshot.fvgs.bearish ? { top: Math.round(snapshot.fvgs.bearish.top * 100) / 100, bottom: Math.round(snapshot.fvgs.bearish.bottom * 100) / 100, atrDistance: snapshot.fvgs.bearish.atrDistance !== null ? Math.round(snapshot.fvgs.bearish.atrDistance * 10) / 10 : null } : null,
    },
    sma: {
      priceVsSma50: snapshot.sma.priceVsSma50,
      priceVsSma200: snapshot.sma.priceVsSma200,
      cross: snapshot.sma.cross,
      crossCandlesAgo: snapshot.sma.crossCandlesAgo,
    },
  };
}
