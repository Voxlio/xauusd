/** Twelve Data time_series client for XAU/USD candles (free Basic plan compatible). */
import { BUDGET, CANDLE_COUNT, SYMBOL } from "../config";
import { UpstreamError } from "../server/errors";
import { fetchJson, isRecord } from "../server/http";
import { parseUtcDatetime } from "../time";
import type { CacheResult } from "../server/cache";
import type { Candle, Timeframe } from "../types";
import type { DataContext } from "./context";

const SOURCE = "Twelve Data";
const BASE_URL = "https://api.twelvedata.com/time_series";

export const TWELVE_DATA_INTERVAL: Record<Timeframe, string> = {
  M15: "15min",
  H1: "1h",
  H4: "4h",
  D1: "1day",
  W1: "1week",
};

function describeApiError(code: number, message: string): string {
  if (code === 401) return "Twelve Data rejected the API key (check TWELVE_DATA_API_KEY)";
  if (code === 403) return "Your Twelve Data plan does not include this data";
  if (code === 429) return "Twelve Data rate limit reached (free plan: 8 requests/minute); try again in a minute";
  if (code === 400 || code === 404) return `Twelve Data rejected the request: ${message.slice(0, 160)}`;
  return `Twelve Data error ${code}: ${message.slice(0, 160)}`;
}

/** Converts a time_series response to ascending, de-duplicated, sane candles. */
export function parseTwelveDataSeries(data: unknown): Candle[] {
  if (!isRecord(data)) throw new UpstreamError(SOURCE, "parse", "Twelve Data returned an unexpected payload");
  if (data.status === "error") {
    const code = typeof data.code === "number" ? data.code : 0;
    const message = typeof data.message === "string" ? data.message : "unknown error";
    throw new UpstreamError(SOURCE, "api", describeApiError(code, message), code || null);
  }
  if (!Array.isArray(data.values)) {
    throw new UpstreamError(SOURCE, "parse", "Twelve Data response has no candle values");
  }

  const byTime = new Map<number, Candle>();
  for (const row of data.values) {
    if (!isRecord(row) || typeof row.datetime !== "string") continue;
    const time = parseUtcDatetime(row.datetime);
    const open = Number(row.open);
    const high = Number(row.high);
    const low = Number(row.low);
    const close = Number(row.close);
    if (time === null || ![open, high, low, close].every((v) => Number.isFinite(v) && v > 0)) continue;
    if (high < low || high < Math.max(open, close) - 1e-9 || low > Math.min(open, close) + 1e-9) continue;
    byTime.set(time, { time, open, high, low, close });
  }
  const candles = [...byTime.values()].sort((a, b) => a.time - b.time);
  if (candles.length === 0) throw new UpstreamError(SOURCE, "parse", "Twelve Data returned no valid candles");
  return candles;
}

export function buildTwelveDataUrl(timeframe: Timeframe, apiKey: string): string {
  const params = new URLSearchParams({
    symbol: SYMBOL,
    interval: TWELVE_DATA_INTERVAL[timeframe],
    outputsize: String(CANDLE_COUNT),
    timezone: "UTC",
    apikey: apiKey,
  });
  return `${BASE_URL}?${params.toString()}`;
}

export async function fetchCandles(timeframe: Timeframe, ctx: DataContext): Promise<CacheResult<Candle[]>> {
  const ttl = Math.min(ctx.config.cacheTtlMs, BUDGET.candleTtlMaxMs);
  return ctx.cache.get(`twelvedata:${timeframe}`, ttl, BUDGET.staleMaxMs, async () => {
    const res = await fetchJson(SOURCE, buildTwelveDataUrl(timeframe, ctx.config.twelveDataKey), {
      fetchImpl: ctx.fetchImpl,
      timeoutMs: ctx.timeoutMs,
    });
    if (!res.ok && !isRecord(res.data)) {
      throw new UpstreamError(SOURCE, "http", `Twelve Data returned HTTP ${res.status}`, res.status);
    }
    return parseTwelveDataSeries(res.data);
  });
}
