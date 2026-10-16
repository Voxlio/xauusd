/**
 * Builds the model prompt from code-computed data. The model never sees raw
 * candles: only indicator values, levels, macro readings and the calendar.
 */
import { RULES } from "../config";
import { round } from "../num";
import { direction, entryRange, stopBounds, type Side } from "../signal/levels";
import type { CalendarSummary, MacroSeries, MacroSummary, Mode, TechnicalSummary } from "../types";

export const MAX_OUTPUT_TOKENS = 1000;

export const SYSTEM_PROMPT = `You are a disciplined XAU/USD (spot gold) analyst producing one educational trade idea for a demo account.
You receive a JSON summary computed by code: multi-timeframe technicals, US real yield and dollar data, and the high-impact USD calendar. Use only this data. Do not invent prices, levels, events or news.

How to decide BUY, SELL or NO_TRADE:
- The trend timeframe sets the preferred direction, the setup timeframe defines structure and levels, the trigger timeframe times the entry.
- Choose NO_TRADE when the timeframes conflict, price is mid-range with no edge, or the risk rules below cannot be met.
- Falling real yields and a weaker dollar usually support gold; rising ones weigh on it. Treat macro as context, not a trigger.

Hard rules. The server checks every number and rejects or corrects ideas that break them:
- entry must be inside riskFrame.entryRange (at most ${RULES.entryMaxAtr} x ATR from the current price).
- stopLoss must be ${RULES.stopMinAtr} to ${RULES.stopMaxAtr} x ATR from entry and beyond the nearest swing level. Use riskFrame.buy or riskFrame.sell.stopLossRange.
- With R = |entry - stopLoss|: takeProfit1 at least ${RULES.tp1MinR}R and takeProfit2 at least ${RULES.tp2MinR}R from entry, in the trade direction.
- Place targets with nearby support and resistance in mind.

Reply with ONLY one JSON object. No markdown, no code fences, no text before or after. Use exactly these keys:
{"bias":"BUY"|"SELL"|"NO_TRADE","confidence":integer 0-100,"entry":number|null,"stopLoss":number|null,"takeProfit1":number|null,"takeProfit2":number|null,"technicalReasons":[string],"fundamentalReasons":[string],"invalidation":string,"newsWarning":string|null}
- When bias is NO_TRADE, set all four prices to null and explain why in the reasons.
- 2 to 4 technicalReasons and 1 to 3 fundamentalReasons, each under 140 characters, citing the timeframe and values.
- invalidation: one sentence on what would prove the idea wrong.
- newsWarning: summarise upcoming calendar events from the data, or null if there are none.
- confidence is calibrated: 50 is a coin flip, above 75 is rare.`;

function seriesBrief(s: MacroSeries | null) {
  if (!s) return null;
  return { value: s.value, date: s.date, change5: s.change5, change20: s.change20, changePct5: s.changePct5 };
}

function sideFrame(tech: TechnicalSummary, side: Side) {
  const bounds = stopBounds(tech, side, tech.price);
  const dir = direction(side);
  if (!bounds.feasible) {
    return {
      feasible: false,
      nearestSwing: bounds.nearestSwing,
      note: `A stop beyond the nearest swing needs ${(bounds.minDistance / tech.atr).toFixed(2)} x ATR; the maximum is ${RULES.stopMaxAtr}.`,
    };
  }
  const r = bounds.minDistance;
  return {
    feasible: true,
    nearestSwing: bounds.nearestSwing,
    stopLossRange: {
      closest: round(tech.price - dir * bounds.minDistance),
      farthest: round(tech.price - dir * bounds.maxDistance),
    },
    minTakeProfit1: round(tech.price + dir * RULES.tp1MinR * r),
    minTakeProfit2: round(tech.price + dir * RULES.tp2MinR * r),
  };
}

const STYLE: Record<Mode, string> = {
  day: "intraday, held for hours",
  swing: "swing, held for days to a few weeks",
};

export function buildUserPayload(tech: TechnicalSummary, macro: MacroSummary, calendar: CalendarSummary, now: number) {
  const range = entryRange(tech);
  return {
    instrument: "XAU/USD spot gold",
    mode: tech.mode,
    style: STYLE[tech.mode],
    timeUtc: new Date(now).toISOString(),
    price: tech.price,
    atr: { timeframe: tech.setupTimeframe, value: tech.atr },
    riskFrame: {
      note: "Ranges assume entry at the current price; recompute R if you choose a different entry.",
      entryRange: { low: round(range.low), high: round(range.high) },
      buy: sideFrame(tech, "BUY"),
      sell: sideFrame(tech, "SELL"),
    },
    alignment: tech.alignment,
    timeframes: tech.timeframes.map((t) => ({
      tf: t.timeframe,
      role: t.role,
      trend: t.trend,
      trendScore: t.trendScore,
      structure: t.structure,
      close: t.close,
      ema20: t.ema20,
      ema50: t.ema50,
      ema200: t.ema200,
      rsi14: t.rsi14,
      macdHistogram: t.macd ? { now: t.macd.histogram, prev: t.macd.histogramPrev } : null,
      atr14: t.atr14,
      changePct20: t.changePct20,
      swingHighs: t.swingHighs.slice(0, 4),
      swingLows: t.swingLows.slice(0, 4),
      supports: t.supports.map((l) => ({ price: l.price, touches: l.touches })),
      resistances: t.resistances.map((l) => ({ price: l.price, touches: l.touches })),
    })),
    macro: {
      codeTilt: macro.tilt,
      realYield10y: seriesBrief(macro.realYield),
      broadDollarIndex: seriesBrief(macro.usdIndex),
      notes: macro.notes,
    },
    calendar: {
      source: calendar.source,
      highImpactUsdNext48h: calendar.events.slice(0, 8).map((e) => ({
        title: e.title,
        timeUtc: new Date(e.time).toISOString(),
        hoursFromNow: round((e.time - now) / 3_600_000, 1),
        forecast: e.forecast,
        previous: e.previous,
      })),
    },
  };
}

export function buildUserPrompt(tech: TechnicalSummary, macro: MacroSummary, calendar: CalendarSummary, now: number): string {
  return `Analyze this XAU/USD snapshot and reply with the JSON object only.\n${JSON.stringify(
    buildUserPayload(tech, macro, calendar, now),
  )}`;
}
