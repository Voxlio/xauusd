/** FRED client: US 10Y real yield (DFII10) and the broad trade-weighted dollar index (DTWEXBGS). */
import { BUDGET } from "../config";
import { round } from "../num";
import { UpstreamError } from "../server/errors";
import { fetchJson, isRecord } from "../server/http";
import type { CacheResult } from "../server/cache";
import type { MacroSeries } from "../types";
import type { DataContext } from "./context";

const SOURCE = "FRED";
const BASE_URL = "https://api.stlouisfed.org/fred/series/observations";

export const FRED_SERIES = {
  realYield: { id: "DFII10", label: "US 10Y real yield (TIPS)" },
  usdIndex: { id: "DTWEXBGS", label: "Broad US dollar index" },
} as const;

export interface Observation {
  date: string;
  value: number;
}

/** Parses FRED observations, dropping missing values ("."). Returns newest first. */
export function parseFredObservations(data: unknown): Observation[] {
  if (!isRecord(data)) throw new UpstreamError(SOURCE, "parse", "FRED returned an unexpected payload");
  if (typeof data.error_message === "string") {
    const status = typeof data.error_code === "number" ? data.error_code : null;
    const text = /api_key/i.test(data.error_message)
      ? "FRED rejected the API key (check FRED_API_KEY)"
      : `FRED error: ${data.error_message.slice(0, 160)}`;
    throw new UpstreamError(SOURCE, "api", text, status);
  }
  if (!Array.isArray(data.observations)) {
    throw new UpstreamError(SOURCE, "parse", "FRED response has no observations");
  }
  const out: Observation[] = [];
  for (const row of data.observations) {
    if (!isRecord(row) || typeof row.date !== "string" || typeof row.value !== "string") continue;
    const value = Number(row.value);
    if (row.value.trim() === "." || !Number.isFinite(value)) continue;
    out.push({ date: row.date, value });
  }
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  if (out.length === 0) throw new UpstreamError(SOURCE, "parse", "FRED returned no usable observations");
  return out;
}

/** Latest value plus absolute and percentage change vs 5 and 20 observations earlier. */
export function summarizeSeries(id: string, label: string, observations: readonly Observation[]): MacroSeries {
  const latest = observations[0];
  const at = (k: number) => (observations.length > k ? observations[k].value : null);
  const diff = (prev: number | null) => (prev === null ? null : round(latest.value - prev, 4));
  const pct = (prev: number | null) => (prev === null || prev === 0 ? null : round((latest.value / prev - 1) * 100, 3));
  return {
    id,
    label,
    value: round(latest.value, 4),
    date: latest.date,
    change5: diff(at(5)),
    change20: diff(at(20)),
    changePct5: pct(at(5)),
    changePct20: pct(at(20)),
  };
}

export function buildFredUrl(seriesId: string, apiKey: string): string {
  const params = new URLSearchParams({
    series_id: seriesId,
    api_key: apiKey,
    file_type: "json",
    sort_order: "desc",
    limit: "40",
  });
  return `${BASE_URL}?${params.toString()}`;
}

export async function fetchFredSeries(
  series: (typeof FRED_SERIES)[keyof typeof FRED_SERIES],
  ctx: DataContext,
): Promise<CacheResult<MacroSeries>> {
  const apiKey = ctx.config.fredKey;
  if (!apiKey) throw new UpstreamError(SOURCE, "api", "FRED_API_KEY is not set; macro data skipped");
  return ctx.cache.get(`fred:${series.id}`, ctx.config.cacheTtlMs, BUDGET.staleMaxMs * 8, async () => {
    const res = await fetchJson(SOURCE, buildFredUrl(series.id, apiKey), {
      fetchImpl: ctx.fetchImpl,
      timeoutMs: ctx.timeoutMs,
    });
    if (!res.ok && !isRecord(res.data)) {
      throw new UpstreamError(SOURCE, "http", `FRED returned HTTP ${res.status}`, res.status);
    }
    return summarizeSeries(series.id, series.label, parseFredObservations(res.data));
  });
}
