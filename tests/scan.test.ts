import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { handleScanRequest, secretsMatch, type ScanDeps } from "../lib/alerts/scan";
import { createMemoryStore, type AlertStore } from "../lib/alerts/store";
import type { SendTelegram } from "../lib/alerts/telegram";
import { TelegramError } from "../lib/alerts/telegram";
import { TtlCache } from "../lib/server/cache";
import type { SignalResponse, TechnicalSummary, ValidatedSignal } from "../lib/types";
import { scriptedFetch } from "./fakes";
import { compliantBuy, fakeAI, MARKET_NOW } from "./market";

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
  sent: string[];
  generated: string[];
}

function harness(opts: { signal?: ValidatedSignal; now?: number; alignment?: TechnicalSummary["alignment"]; store?: AlertStore | null; send?: SendTelegram } = {}): Harness {
  const store = createMemoryStore();
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
    sendTelegram: opts.send ?? (async ({ text }) => void sent.push(text)),
  };
  return { deps, store, sent, generated };
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
    assert.match(h.sent[0], /XAU\/USD BUY \(Day\)/);
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
  });

  test("missing Telegram config is reported without values", async () => {
    const h = harness();
    const res = await handleScanRequest(req(), { ...h.deps, env: { ...ENV, TELEGRAM_BOT_TOKEN: undefined } });
    assert.equal(res.status, 500);
    assert.equal(h.generated.length, 0);
  });
});
