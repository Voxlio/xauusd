import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildTwelveDataUrl, fetchCandles, parseTwelveDataSeries } from "../lib/data/twelvedata";
import { buildFredUrl, fetchFredSeries, FRED_SERIES, parseFredObservations, summarizeSeries } from "../lib/data/fred";
import { fetchCalendar, parseFinnhubCalendar, parseForexFactoryCalendar } from "../lib/data/calendar";
import { TtlCache } from "../lib/server/cache";
import { UpstreamError } from "../lib/server/errors";
import { fetchJson } from "../lib/server/http";
import { parseUtcDatetime } from "../lib/time";
import type { DataContext } from "../lib/data/context";
import { hangingRoute, jsonResponse, scriptedFetch, testConfig } from "./fakes";

function ctxWith(fetchImpl: DataContext["fetchImpl"], overrides: Parameters<typeof testConfig>[0] = {}): DataContext {
  return { config: testConfig(overrides), fetchImpl, cache: new TtlCache(), timeoutMs: 500 };
}

describe("Twelve Data", () => {
  const payload = {
    meta: { symbol: "XAU/USD", interval: "1h" },
    values: [
      { datetime: "2026-10-16 10:00:00", open: "2410.5", high: "2415.2", low: "2408.1", close: "2412.0" },
      { datetime: "2026-10-16 09:00:00", open: "2405.0", high: "2411.0", low: "2401.3", close: "2410.5" },
      { datetime: "2026-10-16 09:00:00", open: "2405.0", high: "2411.0", low: "2401.3", close: "2410.5" },
      { datetime: "2026-10-16 08:00:00", open: "bad", high: "1", low: "1", close: "1" },
      { datetime: "2026-10-16 07:00:00", open: "2400", high: "2390", low: "2395", close: "2398" },
    ],
    status: "ok",
  };

  test("parses, sorts ascending, de-duplicates and drops invalid rows", () => {
    const candles = parseTwelveDataSeries(payload);
    assert.equal(candles.length, 2);
    assert.equal(candles[0].time, Date.UTC(2026, 9, 16, 9));
    assert.equal(candles[1].close, 2412);
  });

  test("maps API errors to readable messages", () => {
    assert.throws(
      () => parseTwelveDataSeries({ status: "error", code: 429, message: "You have run out of API credits" }),
      (e: unknown) => e instanceof UpstreamError && /rate limit/.test(e.message) && e.status === 429,
    );
    assert.throws(
      () => parseTwelveDataSeries({ status: "error", code: 401, message: "invalid api key" }),
      /TWELVE_DATA_API_KEY/,
    );
    assert.throws(() => parseTwelveDataSeries({ status: "ok" }), UpstreamError);
  });

  test("URL requests UTC timestamps and enough bars", () => {
    const url = new URL(buildTwelveDataUrl("M15", "k"));
    assert.equal(url.searchParams.get("symbol"), "XAU/USD");
    assert.equal(url.searchParams.get("interval"), "15min");
    assert.equal(url.searchParams.get("timezone"), "UTC");
    assert.equal(url.searchParams.get("outputsize"), "500");
  });

  test("fetchCandles caches within the TTL", async () => {
    const { fetchImpl, calls } = scriptedFetch([["api.twelvedata.com", () => jsonResponse(payload)]]);
    const ctx = ctxWith(fetchImpl);
    const first = await fetchCandles("H1", ctx);
    const second = await fetchCandles("H1", ctx);
    assert.equal(first.state, "fresh");
    assert.equal(second.state, "cache");
    assert.equal(calls.length, 1);
  });

  test("datetime parsing handles dates with and without time", () => {
    assert.equal(parseUtcDatetime("2026-10-16"), Date.UTC(2026, 9, 16));
    assert.equal(parseUtcDatetime("2026-10-16 13:45:00"), Date.UTC(2026, 9, 16, 13, 45));
    assert.equal(parseUtcDatetime("16/10/2026"), null);
  });
});

describe("FRED", () => {
  const observations = Array.from({ length: 25 }, (_, i) => ({
    date: `2026-09-${String(30 - i).padStart(2, "0")}`,
    value: i === 2 ? "." : (1.8 + i * 0.01).toFixed(2),
  }));

  test("drops missing values and sorts newest first", () => {
    const parsed = parseFredObservations({ observations: observations.slice().reverse() });
    assert.equal(parsed.length, 24);
    assert.equal(parsed[0].date, "2026-09-30");
    assert.ok(parsed.every((o) => Number.isFinite(o.value)));
  });

  test("summarizes level and changes", () => {
    const s = summarizeSeries("DFII10", "Real yield", [
      { date: "2026-10-15", value: 1.7 },
      { date: "2026-10-14", value: 1.72 },
      { date: "2026-10-13", value: 1.74 },
      { date: "2026-10-10", value: 1.76 },
      { date: "2026-10-09", value: 1.78 },
      { date: "2026-10-08", value: 1.8 },
    ]);
    assert.equal(s.value, 1.7);
    assert.equal(s.change5, -0.1);
    assert.equal(s.change20, null);
    assert.ok(s.changePct5 !== null && s.changePct5 < 0);
  });

  test("reports a bad key clearly", () => {
    assert.throws(
      () => parseFredObservations({ error_code: 400, error_message: "Bad Request. The value for variable api_key is not registered." }),
      /FRED_API_KEY/,
    );
  });

  test("URL asks for newest observations as JSON", () => {
    const url = new URL(buildFredUrl("DFII10", "k"));
    assert.equal(url.searchParams.get("series_id"), "DFII10");
    assert.equal(url.searchParams.get("file_type"), "json");
    assert.equal(url.searchParams.get("sort_order"), "desc");
  });

  test("missing key fails fast without a request", async () => {
    const { fetchImpl, calls } = scriptedFetch([]);
    await assert.rejects(fetchFredSeries(FRED_SERIES.realYield, ctxWith(fetchImpl, { fredKey: null })), /FRED_API_KEY/);
    assert.equal(calls.length, 0);
  });
});

describe("economic calendar", () => {
  const now = Date.UTC(2026, 9, 16, 10, 0);

  test("Finnhub: keeps only high-impact US events and parses UTC time", () => {
    const events = parseFinnhubCalendar({
      economicCalendar: [
        { country: "US", event: "Nonfarm Payrolls", impact: "high", time: "2026-10-16 12:30:00", estimate: 150, prev: 142 },
        { country: "US", event: "Redbook", impact: "low", time: "2026-10-16 12:55:00" },
        { country: "EU", event: "ECB Rate", impact: "high", time: "2026-10-16 12:15:00" },
      ],
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].title, "Nonfarm Payrolls");
    assert.equal(events[0].time, Date.UTC(2026, 9, 16, 12, 30));
    assert.equal(events[0].forecast, "150");
  });

  test("ForexFactory: keeps only high-impact USD events and honours the offset", () => {
    const events = parseForexFactoryCalendar([
      { title: "CPI m/m", country: "USD", date: "2026-10-16T08:30:00-04:00", impact: "High", forecast: "0.3%", previous: "0.4%" },
      { title: "Retail Sales", country: "USD", date: "2026-10-16T08:30:00-04:00", impact: "Medium" },
      { title: "GDP", country: "GBP", date: "2026-10-16T02:00:00-04:00", impact: "High" },
    ]);
    assert.equal(events.length, 1);
    assert.equal(events[0].time, Date.UTC(2026, 9, 16, 12, 30));
    assert.equal(events[0].source, "forexfactory");
  });

  test("falls back to ForexFactory when Finnhub denies the endpoint", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      ["finnhub.io", () => jsonResponse({ error: "You don't have access to this resource." }, 403)],
      [
        "faireconomy.media",
        () => jsonResponse([{ title: "FOMC Statement", country: "USD", date: "2026-10-16T14:00:00-04:00", impact: "High" }]),
      ],
    ]);
    const ctx = ctxWith(fetchImpl);
    const result = await fetchCalendar(ctx, now);
    assert.equal(result.source, "forexfactory");
    assert.equal(result.events.length, 1);
    assert.match(result.note ?? "", /not included/);

    // The denial is cached, so a second call does not hit Finnhub again.
    await fetchCalendar(ctx, now);
    assert.equal(calls.filter((c) => c.url.includes("finnhub.io")).length, 1);
  });

  test("never throws: reports unavailable when every source fails", async () => {
    const { fetchImpl } = scriptedFetch([]);
    const result = await fetchCalendar(ctxWith(fetchImpl), now);
    assert.equal(result.source, "unavailable");
    assert.deepEqual(result.events, []);
    assert.ok(result.note && result.note.length > 0);
  });

  test("uses Finnhub when it works and never leaks the token in notes", async () => {
    const { fetchImpl } = scriptedFetch([
      [
        "finnhub.io",
        () =>
          jsonResponse({
            economicCalendar: [{ country: "US", event: "CPI", impact: "high", time: "2026-10-16 12:30:00" }],
          }),
      ],
    ]);
    const result = await fetchCalendar(ctxWith(fetchImpl), now);
    assert.equal(result.source, "finnhub");
    assert.equal(result.events.length, 1);
    assert.ok(!(result.note ?? "").includes("fh-test-key"));
  });
});

describe("fetchJson", () => {
  test("times out a hung upstream", async () => {
    const { fetchImpl } = scriptedFetch([["slow.example", hangingRoute]]);
    await assert.rejects(
      fetchJson("Slow", "https://slow.example/data?apikey=secret", { fetchImpl, timeoutMs: 50 }),
      (e: unknown) => e instanceof UpstreamError && e.kind === "timeout" && !e.message.includes("secret"),
    );
  });

  test("network errors do not include the URL", async () => {
    const { fetchImpl } = scriptedFetch([]);
    await assert.rejects(
      fetchJson("Down", "https://down.example/?token=secret", { fetchImpl, timeoutMs: 100 }),
      (e: unknown) => e instanceof UpstreamError && e.kind === "network" && !e.message.includes("secret"),
    );
  });

  test("non-JSON error pages become HTTP errors", async () => {
    const { fetchImpl } = scriptedFetch([["html.example", () => new Response("<html>502</html>", { status: 502 })]]);
    await assert.rejects(
      fetchJson("Html", "https://html.example/", { fetchImpl, timeoutMs: 100 }),
      (e: unknown) => e instanceof UpstreamError && e.kind === "http" && e.status === 502,
    );
  });
});
