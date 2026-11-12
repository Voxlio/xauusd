import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { handleScanRequest, secretsMatch, type ScanDeps } from "../lib/alerts/scan";
import { createMemoryStore, type AlertStore } from "../lib/alerts/store";
import { createMemoryCallStore, type CallStore } from "../lib/calls/store";
import type { Call } from "../lib/calls/types";
import { AppError } from "../lib/server/errors";
import type { SendTelegram } from "../lib/alerts/telegram";
import { TelegramError } from "../lib/alerts/telegram";
import { TtlCache } from "../lib/server/cache";
import type { SignalResponse, TechnicalSummary, ValidatedSignal } from "../lib/types";
import { jsonResponse, scriptedFetch } from "./fakes";
import { compliantBuy, fakeAI, finnhubRoute, fredRoute, MARKET_NOW, marketCandles, toTwelveDataPayload, twelveDataRoute } from "./market";
import { generateSignal } from "../lib/signal/service";

const SECRET = "cron-secret-0123456789";
const ENV = {
  TWELVE_DATA_API_KEY: "td-secret-123",
  ANTHROPIC_API_KEY: "sk-ant-secret",
  CRON_SECRET: SECRET,
  TELEGRAM_BOT_TOKEN: "123456:tg-secret-token",
  TELEGRAM_CHAT_ID: "42",
  KV_REST_API_URL: "https://redis.example",
  KV_REST_API_TOKEN: "redis-secret-token",
};
const SAT = Date.UTC(2026, 9, 17, 10, 5);

function signal(overrides: Partial<ValidatedSignal> = {}): ValidatedSignal {
  return {
    bias: "BUY", confidence: 72, entry: 2400, entryType: "limit", stopLoss: 2390, takeProfit1: 2415, takeProfit2: 2425,
    riskReward1: 1.5, riskReward2: 2.5, riskUsd: 10, stopAtr: 1.2, technicalReasons: ["H4 uptrend"], fundamentalReasons: [],
    invalidation: "Below 2,390", newsWarning: null, aiNewsNote: null, noTradeReasons: [], corrections: [], warnings: [],
    decidedBy: "ai", smcVerdict: "agree", ...overrides,
  };
}

function response(s: ValidatedSignal): SignalResponse {
  return { signal: s, snapshot: { atr: 6 } as SignalResponse["snapshot"], meta: { provider: "fake", model: "fake", durationMs: 1, aiDurationMs: 1 } };
}

interface Harness {
  deps: Partial<ScanDeps>;
  store: ReturnType<typeof createMemoryStore>;
  callStore: ReturnType<typeof createMemoryCallStore>;
  sent: string[];
  generated: string[];
}

function harness(opts: { signal?: ValidatedSignal; now?: number; alignment?: TechnicalSummary["alignment"]; store?: AlertStore | null; send?: SendTelegram; callStore?: CallStore | null } = {}): Harness {
  const store = createMemoryStore();
  const callStore = createMemoryCallStore();
  const sent: string[] = [];
  const generated: string[] = [];
  const deps: Partial<ScanDeps> = {
    env: ENV,
    fetchImpl: scriptedFetch([]).fetchImpl,
    cache: new TtlCache(),
    createProvider: () => fakeAI(compliantBuy),
    now: () => opts.now ?? MARKET_NOW,
    generate: async (mode, d) => {
      generated.push(mode);
      const skip = d.skipAi?.({ alignment: opts.alignment ?? { up: 2, down: 0, range: 1 } } as TechnicalSummary) ?? null;
      if (skip) return response(signal({ bias: "NO_TRADE", confidence: null, entry: null, decidedBy: "rules" }));
      return response(opts.signal ?? signal());
    },
    createStore: () => (opts.store === undefined ? store : opts.store),
    createCallStore: () => (opts.callStore === undefined ? callStore : opts.callStore),
    newId: () => "TESTID",
    sendTelegram: opts.send ?? (async ({ text }) => void sent.push(text)),
  };
  return { deps, store, callStore, sent, generated };
}

function req(method = "POST", url = "https://app.example/api/cron/scan?mode=day", token: string | null = SECRET): Request {
  return new Request(url, { method, headers: token === null ? {} : { authorization: `Bearer ${token}` } });
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("POST /api/cron/scan", () => {
  test("405 on GET with an allow header", async () => {
    const res = await handleScanRequest(req("GET"), harness().deps);
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "POST");
  });

  test("401 without a secret, with a wrong secret, and when CRON_SECRET is unset", async () => {
    const h = harness();
    assert.equal((await handleScanRequest(req("POST", undefined, null), h.deps)).status, 401);
    assert.equal((await handleScanRequest(req("POST", undefined, "wrong"), h.deps)).status, 401);
    const unset = await handleScanRequest(req("POST", undefined, ""), { ...h.deps, env: { ...ENV, CRON_SECRET: "" } });
    assert.equal(unset.status, 401);
    const unset2 = await handleScanRequest(req(), { ...h.deps, env: { ...ENV, CRON_SECRET: undefined } });
    assert.equal(unset2.status, 401);
    assert.equal(h.generated.length, 0, "the pipeline never ran");
  });

  test("secretsMatch is exact", () => {
    assert.equal(secretsMatch("abc", "abc"), true);
    assert.equal(secretsMatch("abc", "abd"), false);
    assert.equal(secretsMatch("abc", "abcd"), false);
  });

  test("400 for a missing or invalid mode", async () => {
    const h = harness();
    assert.equal((await handleScanRequest(req("POST", "https://app.example/api/cron/scan"), h.deps)).status, 400);
    assert.equal((await handleScanRequest(req("POST", "https://app.example/api/cron/scan?mode=hour"), h.deps)).status, 400);
  });

  test("mode can come from a JSON body", async () => {
    const h = harness();
    const request = new Request("https://app.example/api/cron/scan", {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: '{"mode":"swing"}',
    });
    const res = await handleScanRequest(request, h.deps);
    assert.equal((await body(res)).status, "sent");
    assert.deepEqual(h.generated, ["swing"]);
  });

  test("send path: formats the message, records the last alert, and leaks no secrets", async () => {
    const h = harness();
    const res = await handleScanRequest(req(), h.deps);
    assert.equal(res.status, 200);
    const text = JSON.stringify(await body(res));
    assert.match(text, /"status":"sent"/);
    for (const secret of Object.values(ENV)) assert.ok(!text.includes(secret), "no secrets in the response");
    assert.equal(h.sent.length, 1);
    assert.match(h.sent[0], /NEW CALL: XAU\/USD BUY<\/b> \(Day\) <code>#TESTID<\/code>/);
    assert.equal((await h.callStore.get("TESTID"))?.status, "PENDING", "the alert became a tracked call");
    assert.equal((await h.callStore.get("TESTID"))?.validUntil, MARKET_NOW + 30 * 60_000);
    assert.deepEqual(h.store.last.get("alert:last:day:BUY"), { entry: 2400, at: MARKET_NOW, confidence: 72 });
  });

  test("skip path: NO_TRADE, low confidence and SMC against send nothing", async () => {
    for (const s of [
      signal({ bias: "NO_TRADE", confidence: null, entry: null }),
      signal({ confidence: 55 }),
      signal({ smcVerdict: "against" }),
    ]) {
      const h = harness({ signal: s });
      const res = await handleScanRequest(req(), h.deps);
      const b = await body(res);
      assert.equal(b.status, "skipped");
      assert.equal(h.sent.length, 0);
    }
  });

  test("skip path: the second alert inside the cooldown is not sent", async () => {
    const h = harness();
    assert.equal((await body(await handleScanRequest(req(), h.deps))).status, "sent");
    h.store.locks.clear(); // lock would have expired; the cooldown record is what blocks
    const again = await body(await handleScanRequest(req(), h.deps));
    assert.deepEqual([again.status, again.reason], ["skipped", "cooldown_day_BUY"]);
    assert.equal(h.sent.length, 1);
  });

  test("duplicate-lock path: an overlapping run does not send", async () => {
    const h = harness();
    await h.store.acquireLock("day", "BUY", 120);
    const res = await handleScanRequest(req(), h.deps);
    assert.deepEqual(await body(res), { status: "skipped", reason: "duplicate_lock" });
    assert.equal(h.sent.length, 0);
  });

  test("market closed: skipped before the pipeline runs", async () => {
    const h = harness({ now: SAT });
    const res = await handleScanRequest(req(), h.deps);
    assert.deepEqual(await body(res), { status: "skipped", reason: "market_closed" });
    assert.equal(h.generated.length, 0);
  });

  test("session filter: skipped before the pipeline when enabled", async () => {
    const night = Date.UTC(2026, 9, 16, 3, 0); // Friday 03:00 UTC, market open, outside London/NY
    const h = harness({ now: night });
    const off = await body(await handleScanRequest(req(), h.deps));
    assert.equal(off.status, "sent");
    const h2 = harness({ now: night });
    const on = await body(await handleScanRequest(req(), { ...h2.deps, env: { ...ENV, ALERT_SESSIONS_ONLY: "true" } }));
    assert.deepEqual(on, { status: "skipped", reason: "outside_session" });
    assert.equal(h2.generated.length, 0);
  });

  test("pre-check: fully mixed trend votes skip the scan", async () => {
    const h = harness({ alignment: { up: 1, down: 1, range: 1 } });
    const res = await handleScanRequest(req(), h.deps);
    assert.deepEqual(await body(res), { status: "skipped", reason: "trend_votes_mixed" });
    assert.equal(h.sent.length, 0);
  });

  test("fails closed when Redis is not configured or errors", async () => {
    const none = harness({ store: null });
    const r1 = await handleScanRequest(req(), none.deps);
    assert.equal(r1.status, 503);
    assert.equal(none.generated.length, 0);

    const broken: AlertStore = {
      getLast: async () => { throw Object.assign(new Error("Redis could not be reached"), { name: "StoreError" }); },
      saveLast: async () => undefined,
      acquireLock: async () => true,
      releaseLock: async () => undefined,
    };
    const h = harness({ store: broken });
    const r2 = await handleScanRequest(req(), h.deps);
    assert.equal(r2.status, 503);
    assert.equal((await body(r2)).status, "error");
    assert.equal(h.sent.length, 0);
  });

  test("Telegram failure: error response, lock released, nothing recorded", async () => {
    const h = harness({ send: async () => { throw new TelegramError("Telegram rejected the message (HTTP 401)", 401); } });
    const res = await handleScanRequest(req(), h.deps);
    assert.equal(res.status, 502);
    const text = JSON.stringify(await body(res));
    assert.ok(!text.includes("tg-secret-token"));
    assert.equal(h.store.last.size, 0);
    assert.equal(h.store.locks.size, 0);
    assert.equal(h.callStore.calls.size, 0, "no tracked call for a message that was never delivered");
  });

  test("missing Telegram config is reported without values", async () => {
    const h = harness();
    const res = await handleScanRequest(req(), { ...h.deps, env: { ...ENV, TELEGRAM_BOT_TOKEN: undefined } });
    assert.equal(res.status, 500);
    assert.equal(h.generated.length, 0);
  });
});

describe("cron scan: call tracker", () => {
  const T = MARKET_NOW;
  function openCall(over: Partial<Call> = {}): Call {
    return {
      id: "OPEN01", mode: "day", side: "BUY", entry: 2400, stopLoss: 2390, tp1: 2415, tp2: 2425, confidence: 70, smcVerdict: "agree",
      createdAt: T - 60 * 60_000, validUntil: T + 60 * 60_000, status: "ACTIVE", enteredAt: T - 45 * 60_000, lastCheckedAt: T - 60 * 60_000, ...over,
    };
  }
  /** Two closed M15 candles after the call was created; the second one reaches TP1. */
  const trackerCandles = () => {
    const start = T - 60 * 60_000;
    return [0, 1, 2, 3].map((i) => ({
      time: start + i * 15 * 60_000,
      open: 2405,
      close: 2405,
      high: i === 2 ? 2416 : 2406,
      low: 2404,
    }));
  };
  const candleRoute = () => ["api.twelvedata.com", () => jsonResponse(toTwelveDataPayload(trackerCandles()))] as [string, () => Response];

  test("sends one message per new event, updates the call and reports it", async () => {
    const h = harness();
    await h.callStore.create(openCall());
    const res = await handleScanRequest(req(), { ...h.deps, fetchImpl: scriptedFetch([candleRoute()]).fetchImpl, signal: undefined } as Partial<ScanDeps>);
    const b = await body(res);
    assert.equal(b.status, "sent");
    assert.deepEqual(b.tracker, { checked: 1, events: 1 });
    assert.equal(h.sent.length, 2, "one TP1 message and one new-call alert");
    assert.match(h.sent[0], /TP1 secured/);
    assert.equal((await h.callStore.get("OPEN01"))?.status, "TP1_HIT");
    assert.equal(h.generated.length, 1);
  });

  test("a tracker failure does not block the scan", async () => {
    const broken: CallStore = { ...createMemoryCallStore(), listOpen: async () => { throw new Error("redis exploded"); } };
    const h = harness({ callStore: broken });
    const res = await handleScanRequest(req(), h.deps);
    const b = await body(res);
    assert.equal(b.status, "sent");
    assert.deepEqual(b.tracker, { checked: 0, events: 0, error: "tracker_failed" });
    assert.equal(h.sent.length, 1);
  });

  test("a scan failure does not undo the tracker's work", async () => {
    const h = harness();
    await h.callStore.create(openCall());
    const failing: Partial<ScanDeps> = {
      ...h.deps,
      fetchImpl: scriptedFetch([candleRoute()]).fetchImpl,
      generate: async () => { throw new AppError(502, "MARKET_DATA_UNAVAILABLE", "no candles"); },
    };
    const res = await handleScanRequest(req(), failing);
    assert.equal(res.status, 502);
    const b = await body(res);
    assert.deepEqual(b.tracker, { checked: 1, events: 1 });
    assert.match(h.sent[0], /TP1 secured/);
    assert.equal((await h.callStore.get("OPEN01"))?.status, "TP1_HIT");
  });

  test("the tracker runs even when the market is closed (expiry messages still go out)", async () => {
    const h = harness({ now: SAT });
    await h.callStore.create(openCall({ status: "PENDING", enteredAt: undefined, createdAt: SAT - 3 * 3_600_000, lastCheckedAt: SAT - 3 * 3_600_000, validUntil: SAT - 2 * 3_600_000 }));
    const res = await handleScanRequest(req(), { ...h.deps, fetchImpl: scriptedFetch([["api.twelvedata.com", () => jsonResponse(toTwelveDataPayload([{ time: SAT - 3 * 3_600_000, open: 2420, high: 2421, low: 2419, close: 2420 }]))]]).fetchImpl });
    const b = await body(res);
    assert.equal(b.reason, "market_closed");
    assert.match(h.sent[0], /Expired/);
    assert.equal((await h.callStore.get("OPEN01"))?.status, "EXPIRED");
  });

  test("with no open calls there is no tracker field and no candle request", async () => {
    const h = harness();
    const { fetchImpl, calls } = scriptedFetch([]);
    const res = await handleScanRequest(req(), { ...h.deps, fetchImpl });
    assert.equal((await body(res)).tracker, undefined);
    assert.equal(calls.length, 0);
  });

  test("the tracker and the Day pipeline share one M15 request", async () => {
    const candles = marketCandles();
    const { fetchImpl, calls } = scriptedFetch([
      ["api.twelvedata.com", twelveDataRoute(candles)],
      ["api.stlouisfed.org", fredRoute],
      ["finnhub.io", finnhubRoute()],
    ]);
    const h = harness();
    await h.callStore.create(openCall({ entry: 99_999, status: "PENDING", enteredAt: undefined, createdAt: T - 20 * 60_000, lastCheckedAt: T - 20 * 60_000, validUntil: T + 10 * 60_000, stopLoss: 1 }));
    const deps: Partial<ScanDeps> = { ...h.deps, fetchImpl, generate: generateSignal, createProvider: () => fakeAI(compliantBuy) };
    const res = await handleScanRequest(req(), deps);
    assert.equal(res.status, 200);
    const m15 = calls.filter((c) => c.url.includes("interval=15min"));
    assert.equal(m15.length, 1, "one M15 request for the tracker and the pipeline together");
  });
});
