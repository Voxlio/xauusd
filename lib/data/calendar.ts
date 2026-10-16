/**
 * Economic calendar: Finnhub first, then the free ForexFactory weekly JSON export.
 * Only high-impact US events are kept. Finnhub's /calendar/economic is a premium
 * endpoint on many free keys (HTTP 403), which is why the fallback exists.
 */
import { BUDGET } from "../config";
import { errorMessage, UpstreamError } from "../server/errors";
import { fetchJson, isRecord } from "../server/http";
import { parseUtcDatetime, utcDate } from "../time";
import type { CacheState } from "../server/cache";
import type { CalendarSource, EconomicEvent } from "../types";
import type { DataContext } from "./context";

const FINNHUB = "Finnhub";
const FOREXFACTORY = "ForexFactory";
const FINNHUB_URL = "https://finnhub.io/api/v1/calendar/economic";
export const FOREXFACTORY_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

const DAY_MS = 86_400_000;

function text(value: unknown): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** Finnhub: { economicCalendar: [{ country: "US", event, impact: "high", time: "YYYY-MM-DD HH:MM:SS" (UTC), estimate, prev }] } */
export function parseFinnhubCalendar(data: unknown): EconomicEvent[] {
  if (!isRecord(data)) throw new UpstreamError(FINNHUB, "parse", "Finnhub returned an unexpected payload");
  if (typeof data.error === "string") throw new UpstreamError(FINNHUB, "api", `Finnhub error: ${data.error.slice(0, 160)}`);
  const rows = data.economicCalendar;
  if (!Array.isArray(rows)) throw new UpstreamError(FINNHUB, "parse", "Finnhub response has no economicCalendar");
  const events: EconomicEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const country = text(row.country)?.toUpperCase();
    const impact = text(row.impact)?.toLowerCase();
    const title = text(row.event);
    const timeText = text(row.time);
    if (country !== "US" || impact !== "high" || !title || !timeText) continue;
    const time = parseUtcDatetime(timeText);
    if (time === null) continue;
    events.push({
      time,
      title,
      country: "US",
      impact: "high",
      source: "finnhub",
      forecast: text(row.estimate),
      previous: text(row.prev),
    });
  }
  return events;
}

/** ForexFactory: [{ title, country: "USD", date: ISO-8601 with offset, impact: "High", forecast, previous }] */
export function parseForexFactoryCalendar(data: unknown): EconomicEvent[] {
  if (!Array.isArray(data)) throw new UpstreamError(FOREXFACTORY, "parse", "ForexFactory returned an unexpected payload");
  const events: EconomicEvent[] = [];
  for (const row of data) {
    if (!isRecord(row)) continue;
    const country = text(row.country)?.toUpperCase();
    const impact = text(row.impact)?.toLowerCase();
    const title = text(row.title);
    const dateText = text(row.date);
    if (country !== "USD" || impact !== "high" || !title || !dateText) continue;
    const time = Date.parse(dateText);
    if (!Number.isFinite(time)) continue;
    events.push({
      time,
      title,
      country: "US",
      impact: "high",
      source: "forexfactory",
      forecast: text(row.forecast),
      previous: text(row.previous),
    });
  }
  return events;
}

export interface CalendarFetchResult {
  source: CalendarSource;
  events: EconomicEvent[];
  note: string | null;
  state: CacheState | "missing";
  ageMs: number | null;
}

function describeFinnhubStatus(status: number): string {
  if (status === 401) return "Finnhub rejected the API key";
  if (status === 403) return "Finnhub's economic calendar is not included in this API key's plan";
  if (status === 429) return "Finnhub rate limit reached";
  return `Finnhub returned HTTP ${status}`;
}

/** Permanent denials (bad key / plan) are returned, not thrown, so they get cached and skipped quickly. */
type FinnhubResult = { events: EconomicEvent[]; denied: null } | { events: null; denied: string };

async function loadFinnhub(ctx: DataContext, apiKey: string, now: number, timeoutMs: number): Promise<FinnhubResult> {
  const params = new URLSearchParams({ from: utcDate(now - DAY_MS), to: utcDate(now + 3 * DAY_MS), token: apiKey });
  const res = await fetchJson(FINNHUB, `${FINNHUB_URL}?${params.toString()}`, {
    fetchImpl: ctx.fetchImpl,
    timeoutMs,
  });
  if (res.status === 401 || res.status === 403) return { events: null, denied: describeFinnhubStatus(res.status) };
  if (!res.ok) throw new UpstreamError(FINNHUB, "http", describeFinnhubStatus(res.status), res.status);
  return { events: parseFinnhubCalendar(res.data), denied: null };
}

async function loadForexFactory(ctx: DataContext, timeoutMs: number) {
  const res = await fetchJson(FOREXFACTORY, FOREXFACTORY_URL, {
    fetchImpl: ctx.fetchImpl,
    timeoutMs,
    headers: { "user-agent": "xauusd-signal/1.0 (educational)" },
  });
  if (!res.ok) throw new UpstreamError(FOREXFACTORY, "http", `ForexFactory returned HTTP ${res.status}`, res.status);
  return parseForexFactoryCalendar(res.data);
}

/** Minimum time worth giving the fallback source (capped to a quarter of the step budget). */
const MIN_FALLBACK_MS = 800;

/**
 * Never throws: returns source "unavailable" with a note when every source fails.
 * The whole step (primary + fallback) shares one `ctx.timeoutMs` deadline.
 */
export async function fetchCalendar(ctx: DataContext, now: number): Promise<CalendarFetchResult> {
  const startedAt = Date.now();
  const deadline = startedAt + ctx.timeoutMs;
  const notes: string[] = [];
  const staleMax = 2 * 60 * 60_000;
  const finnhubKey = ctx.config.finnhubKey;

  if (finnhubKey) {
    try {
      const primaryTimeout = ctx.config.calendarFallback === "none" ? ctx.timeoutMs : Math.round(ctx.timeoutMs * 0.6);
      const r = await ctx.cache.get(`calendar:finnhub:${utcDate(now)}`, BUDGET.calendarTtlMs, staleMax, () =>
        loadFinnhub(ctx, finnhubKey, now, primaryTimeout),
      );
      if (r.value.events) {
        return { source: "finnhub", events: r.value.events, note: r.error, state: r.state, ageMs: r.ageMs };
      }
      notes.push(r.value.denied);
    } catch (error) {
      notes.push(errorMessage(error));
    }
  } else {
    notes.push("FINNHUB_API_KEY not set");
  }

  if (ctx.config.calendarFallback === "forexfactory") {
    const remaining = deadline - Date.now();
    if (remaining >= Math.min(MIN_FALLBACK_MS, ctx.timeoutMs / 4)) {
      try {
        const r = await ctx.cache.get("calendar:forexfactory", BUDGET.calendarTtlMs, staleMax, () =>
          loadForexFactory(ctx, remaining),
        );
        const note = `${notes.join("; ")}. Using the ForexFactory calendar instead.`;
        return { source: "forexfactory", events: r.value, note, state: r.state, ageMs: r.ageMs };
      } catch (error) {
        notes.push(errorMessage(error));
      }
    } else {
      notes.push("no time left to try the ForexFactory fallback");
    }
  }

  return { source: "unavailable", events: [], note: notes.join("; "), state: "missing", ageMs: null };
}
