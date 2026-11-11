/**
 * A consistent multi-timeframe market fixture: M15 candles are generated once,
 * then aggregated into H1/H4, and served through a fake Twelve Data/FRED/calendar.
 */
import { TIMEFRAME_MS } from "../lib/config";
import type { AICompletionRequest, AIProvider } from "../lib/ai/provider";
import type { Candle, Timeframe } from "../lib/types";
import { jsonResponse, type Route } from "./fakes";
import { wave } from "./helpers";

/** Friday 16 Oct 2026, 10:05 UTC (market open). */
export const MARKET_NOW = Date.UTC(2026, 9, 16, 10, 5);

export function aggregate(candles: readonly Candle[], stepMs: number): Candle[] {
  const buckets = new Map<number, Candle>();
  for (const c of candles) {
    const key = Math.floor(c.time / stepMs) * stepMs;
    const b = buckets.get(key);
    if (!b) buckets.set(key, { ...c, time: key });
    else {
      b.high = Math.max(b.high, c.high);
      b.low = Math.min(b.low, c.low);
      b.close = c.close;
    }
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

export function marketCandles(lastOpen = MARKET_NOW - 5 * 60_000, n = 4800): Record<"M15" | "H1" | "H4", Candle[]> {
  const step = TIMEFRAME_MS.M15;
  const closes = wave(n, 2000, 0.08, 6, 10);
  const start = lastOpen - (n - 1) * step;
  const m15 = closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    return { time: start + i * step, open, high: Math.max(open, close) + 0.6, low: Math.min(open, close) - 0.6, close };
  });
  return { M15: m15.slice(-500), H1: aggregate(m15, TIMEFRAME_MS.H1).slice(-500), H4: aggregate(m15, TIMEFRAME_MS.H4).slice(-500) };
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

export function toTwelveDataPayload(candles: readonly Candle[]) {
  return {
    meta: { symbol: "XAU/USD" },
    status: "ok",
    values: candles
      .slice()
      .reverse()
      .map((c) => {
        const d = new Date(c.time);
        const datetime = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
        return { datetime, open: c.open.toFixed(2), high: c.high.toFixed(2), low: c.low.toFixed(2), close: c.close.toFixed(2) };
      }),
  };
}

const INTERVAL: Record<string, Timeframe> = { "15min": "M15", "1h": "H1", "4h": "H4" };

export function twelveDataRoute(candles: Partial<Record<Timeframe, Candle[]>>, overrides: Partial<Record<Timeframe, Route>> = {}): Route {
  return (url, init) => {
    const interval = new URL(url).searchParams.get("interval") ?? "";
    const tf = INTERVAL[interval];
    const override = tf ? overrides[tf] : undefined;
    if (override) return override(url, init);
    const data = tf ? candles[tf] : undefined;
    if (!data) return jsonResponse({ status: "error", code: 400, message: `unsupported interval ${interval}` });
    return jsonResponse(toTwelveDataPayload(data));
  };
}

export const fredRoute: Route = (url) => {
  const id = new URL(url).searchParams.get("series_id");
  const base = id === "DFII10" ? 1.9 : 121;
  const step = id === "DFII10" ? 0.02 : 0.15;
  // Newest first, falling series (bullish for gold).
  const observations = Array.from({ length: 30 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 9, 15) - i * 86_400_000).toISOString().slice(0, 10),
    value: (base + i * step).toFixed(3),
  }));
  return jsonResponse({ observations });
};

export function finnhubRoute(events: Array<{ event: string; time: number }> = []): Route {
  return () =>
    jsonResponse({
      economicCalendar: events.map((e) => ({
        country: "US",
        impact: "high",
        event: e.event,
        time: new Date(e.time).toISOString().replace("T", " ").slice(0, 19),
      })),
    });
}

export interface FakeAI extends AIProvider {
  calls: AICompletionRequest[];
}

/** Payload sent to the model (the JSON after the first line of the user prompt). */
export function promptPayload(request: AICompletionRequest) {
  return JSON.parse(request.user.slice(request.user.indexOf("\n") + 1));
}

export function fakeAI(reply: (request: AICompletionRequest) => string | Promise<string>): FakeAI {
  const calls: AICompletionRequest[] = [];
  return {
    name: "fake",
    model: "fake-model",
    calls,
    async complete(request) {
      calls.push(request);
      return reply(request);
    },
  };
}

/** A well-behaved model: takes the code's own risk frame and proposes a BUY at market. */
export const compliantBuy = (request: AICompletionRequest): string => {
  const p = promptPayload(request);
  const buy = p.riskFrame.buy;
  if (!buy.feasible) return JSON.stringify({ bias: "NO_TRADE", confidence: 50, technicalReasons: ["no room"], fundamentalReasons: [], invalidation: "" });
  return JSON.stringify({
    bias: "BUY",
    confidence: 68,
    entry: p.price,
    stopLoss: buy.stopLossRange.closest,
    takeProfit1: buy.minTakeProfit1,
    takeProfit2: buy.minTakeProfit2,
    technicalReasons: ["H4 and H1 uptrends aligned", "M15 pullback held the 20 EMA"],
    fundamentalReasons: ["Real yields are falling"],
    invalidation: "An H1 close below the stop.",
    newsWarning: null,
  });
};
