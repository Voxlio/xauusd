/**
 * Shared domain types used by the server pipeline and the client UI.
 * Prices are USD per troy ounce. Times are epoch milliseconds (UTC).
 */

export type Mode = "day" | "swing";
export type Timeframe = "M15" | "H1" | "H4" | "D1" | "W1";
export type TimeframeRole = "trigger" | "setup" | "trend";
export type Bias = "BUY" | "SELL" | "NO_TRADE";
export type Trend = "up" | "down" | "range";
export type Structure = "higher-highs-lows" | "lower-highs-lows" | "mixed" | "insufficient";

export interface Candle {
  /** Bar open time, epoch ms UTC. Candles are always sorted ascending. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface SwingPoint {
  index: number;
  time: number;
  price: number;
  type: "high" | "low";
}

export interface PriceLevel {
  price: number;
  touches: number;
}

export interface MacdValue {
  macd: number;
  signal: number;
  histogram: number;
  histogramPrev: number;
}

export interface TimeframeSnapshot {
  timeframe: Timeframe;
  role: TimeframeRole;
  bars: number;
  lastTime: number;
  close: number;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  rsi14: number | null;
  macd: MacdValue | null;
  atr14: number | null;
  trend: Trend;
  /** -100 (strong down) .. +100 (strong up). */
  trendScore: number;
  structure: Structure;
  /** Most recent confirmed swing highs/lows, newest first. */
  swingHighs: number[];
  swingLows: number[];
  /** Extremes of the last few, not yet confirmed, bars. */
  recentHigh: number;
  recentLow: number;
  /** Clustered swing levels, nearest to price first. */
  supports: PriceLevel[];
  resistances: PriceLevel[];
  /** % change of close over the last 20 bars. */
  changePct20: number | null;
}

export interface TechnicalSummary {
  mode: Mode;
  price: number;
  /** Open time of the candle whose close is `price`. */
  priceTime: number;
  priceTimeframe: Timeframe;
  setupTimeframe: Timeframe;
  /** ATR(14) of the setup timeframe; the unit for every risk rule. */
  atr: number;
  timeframes: TimeframeSnapshot[];
  alignment: { up: number; down: number; range: number };
}

export interface MacroSeries {
  id: string;
  label: string;
  value: number;
  date: string;
  /** Absolute change vs ~5 and ~20 observations earlier (same unit as value). */
  change5: number | null;
  change20: number | null;
  /** Percentage change vs ~5 and ~20 observations earlier. */
  changePct5: number | null;
  changePct20: number | null;
}

export type MacroTilt = "bullish" | "bearish" | "neutral" | "unknown";

export interface MacroSummary {
  realYield: MacroSeries | null;
  usdIndex: MacroSeries | null;
  /** Code-derived gold tilt from real yields and the dollar. */
  tilt: MacroTilt;
  notes: string[];
}

export interface EconomicEvent {
  time: number;
  title: string;
  country: string;
  impact: "high";
  source: "finnhub" | "forexfactory";
  forecast: string | null;
  previous: string | null;
}

export type CalendarSource = "finnhub" | "forexfactory" | "unavailable";

export interface CalendarSummary {
  source: CalendarSource;
  /** High-impact USD events from 15 minutes ago up to 48h ahead. */
  events: EconomicEvent[];
  note: string | null;
}

export type EntryType = "market" | "limit" | "stop";

export type SmcVerdict = "agree" | "neutral" | "against" | "unavailable";

export interface SmcPenaltyDetail {
  code: "zone" | "choch" | "sweep" | "fvg" | "sma";
  penalty: number;
  message: string;
}

export interface ValidatedSignal {
  bias: Bias;
  /** 0-100 after code adjustments; null when there is no trade. */
  confidence: number | null;
  entry: number | null;
  entryType: EntryType | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  /** Reward multiples of risk (R) for TP1/TP2. */
  riskReward1: number | null;
  riskReward2: number | null;
  /** Stop distance in USD and in ATR multiples. */
  riskUsd: number | null;
  stopAtr: number | null;
  technicalReasons: string[];
  fundamentalReasons: string[];
  invalidation: string;
  newsWarning: string | null;
  aiNewsNote: string | null;
  noTradeReasons: string[];
  corrections: string[];
  warnings: string[];
  /** "ai" when the model was consulted, "rules" when a hard gate decided without it. */
  decidedBy: "ai" | "rules";
  /** SMC-lite filter verdict; added without changing required response schema. */
  smcVerdict?: SmcVerdict;
  smcPenalties?: SmcPenaltyDetail[];
}

export type DataState = "fresh" | "cache" | "stale" | "missing";

export interface DataStatusItem {
  name: string;
  state: DataState;
  ageSeconds: number | null;
  detail: string | null;
}

export interface SignalSnapshot {
  symbol: "XAU/USD";
  mode: Mode;
  generatedAt: string;
  price: number;
  /** Open time of the (possibly still forming) candle that supplied `price`. */
  priceTime: string;
  priceTimeframe: Timeframe;
  setupTimeframe: Timeframe;
  atr: number;
  timeframes: TimeframeSnapshot[];
  macro: MacroSummary;
  calendar: CalendarSummary;
  dataStatus: DataStatusItem[];
  /** Compact SMC structure facts for UI and history (optional for backwards compat). */
  structure?: Record<string, unknown> | null;
}

export interface SignalResponse {
  signal: ValidatedSignal;
  snapshot: SignalSnapshot;
  meta: {
    provider: string;
    model: string;
    durationMs: number;
    aiDurationMs: number | null;
  };
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    hint: string | null;
  };
}
