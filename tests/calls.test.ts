import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CANDLE_MS, evaluateCall, plannedR } from "../lib/calls/tracker";
import { computeStats, isWin, rankFor } from "../lib/calls/stats";
import { callFromFields, callToFields, createMemoryCallStore, createRedisCallStore, CLOSED_TTL_SECONDS } from "../lib/calls/store";
import { candleCountFor, runTracker } from "../lib/calls/run";
import type { Call } from "../lib/calls/types";
import type { Candle } from "../lib/types";
import { TtlCache } from "../lib/server/cache";
import { testConfig, scriptedFetch } from "./fakes";
import { createRedisEmulator } from "./redisFake";
import { toTwelveDataPayload } from "./market";
import { jsonResponse } from "./fakes";

const T0 = Date.UTC(2026, 9, 16, 8, 0);
const M = 60_000;

function call(overrides: Partial<Call> = {}): Call {
  return {
    id: "ABC123", mode: "day", side: "BUY", entry: 2400, stopLoss: 2390, tp1: 2415, tp2: 2425, confidence: 70, smcVerdict: "agree",
    createdAt: T0, validUntil: T0 + 30 * M, status: "PENDING", lastCheckedAt: T0, ...overrides,
  };
}

/** Candle i opens at T0 + i * 15 min. */
function candle(i: number, low: number, high: number, close = (low + high) / 2): Candle {
  return { time: T0 + i * CANDLE_MS, open: close, high, low, close };
}

const LATER = T0 + 24 * 60 * M;
const types = (r: ReturnType<typeof evaluateCall>) => r.events.map((e) => e.type);

describe("evaluateCall (BUY)", () => {
  test("entry touched: PENDING becomes ACTIVE at that candle", () => {
    const r = evaluateCall(call(), [candle(0, 2405, 2410), candle(1, 2399, 2406)], LATER);
    assert.deepEqual(types(r), ["ENTRY"]);
    assert.equal(r.events[0].at, T0 + CANDLE_MS);
    assert.equal(r.call.status, "ACTIVE");
    assert.equal(r.call.enteredAt, T0 + CANDLE_MS);
    assert.equal(r.call.lastCheckedAt, T0 + 2 * CANDLE_MS);
  });

  test("TP1 then TP2: both stages are recorded and the result is the TP2 reward/risk", () => {
    const r = evaluateCall(call(), [candle(0, 2399, 2406), candle(1, 2405, 2416), candle(2, 2410, 2426)], LATER);
    assert.deepEqual(types(r), ["ENTRY", "TP1", "TP2"]);
    assert.equal(r.call.status, "TP2_HIT");
    assert.equal(r.call.tp1At, T0 + CANDLE_MS);
    assert.equal(r.call.closedAt, T0 + 2 * CANDLE_MS);
    assert.equal(r.call.resultR, 2.5);
    assert.equal(plannedR(r.call, r.call.tp1), 1.5);
  });

  test("TP1 then SL closes at -1R and keeps the TP1 timestamp (no breakeven stop)", () => {
    const r = evaluateCall(call(), [candle(0, 2399, 2406), candle(1, 2405, 2416), candle(2, 2388, 2412)], LATER);
    assert.deepEqual(types(r), ["ENTRY", "TP1", "SL"]);
    assert.equal(r.call.status, "SL_HIT");
    assert.equal(r.call.resultR, -1);
    assert.equal(r.call.tp1At, T0 + CANDLE_MS);
  });

  test("entry and SL in the same candle count as SL", () => {
    const r = evaluateCall(call(), [candle(0, 2388, 2406)], LATER);
    assert.deepEqual(types(r), ["ENTRY", "SL"]);
    assert.equal(r.call.status, "SL_HIT");
    assert.equal(r.call.resultR, -1);
  });

  test("a gap down through entry and stop is entry then SL", () => {
    const r = evaluateCall(call({ lastCheckedAt: T0 + CANDLE_MS }), [candle(0, 2405, 2410, 2406), candle(1, 2380, 2384)], LATER);
    assert.deepEqual(types(r), ["ENTRY", "SL"]);
  });

  test("SL level reached before entry voids the setup without a loss", () => {
    // A breakout-style entry above price: price falls to the stop level and never touches entry.
    const r = evaluateCall(call({ entry: 2405 }), [candle(0, 2389, 2396, 2395)], LATER);
    assert.deepEqual(types(r), ["EXPIRED"]);
    assert.equal(r.call.status, "EXPIRED");
    assert.equal(r.call.resultR, undefined);
    assert.equal(r.call.enteredAt, undefined);
  });

  test("same candle touching SL and a target: SL wins", () => {
    const r = evaluateCall(call({ status: "ACTIVE", enteredAt: T0 }), [candle(0, 2389, 2430)], LATER);
    assert.deepEqual(types(r), ["SL"]);
    assert.equal(r.call.resultR, -1);
  });

  test("targets are not counted in the entry candle itself", () => {
    const r = evaluateCall(call(), [candle(0, 2399, 2418)], LATER);
    assert.deepEqual(types(r), ["ENTRY"]);
    const next = evaluateCall(r.call, [candle(0, 2399, 2418), candle(1, 2410, 2417)], LATER);
    assert.deepEqual(types(next), ["TP1"]);
  });

  test("one candle through both targets records TP1 then TP2; a gap over both counts too", () => {
    const active = call({ status: "ACTIVE", enteredAt: T0, lastCheckedAt: T0 + CANDLE_MS });
    const r = evaluateCall(active, [candle(0, 2404, 2406, 2405), candle(1, 2430, 2432)], LATER);
    assert.deepEqual(types(r), ["TP1", "TP2"]);
    assert.equal(r.call.resultR, 2.5);
  });

  test("a PENDING call expires after validUntil, but not before the last pre-expiry candle is closed", () => {
    const candles = [candle(0, 2405, 2410), candle(1, 2406, 2411)];
    const early = evaluateCall(call(), candles, T0 + 40 * M);
    assert.deepEqual(types(early), []);
    assert.equal(early.call.status, "PENDING");
    const done = evaluateCall(call(), candles, T0 + 45 * M);
    assert.deepEqual(types(done), ["EXPIRED"]);
    assert.equal(done.events[0].at, T0 + 30 * M);
    assert.equal(done.call.status, "EXPIRED");
    assert.equal(done.call.closedAt, T0 + 30 * M);
  });

  test("entry touched only after validUntil does not count", () => {
    const r = evaluateCall(call(), [candle(0, 2405, 2410), candle(1, 2406, 2411), candle(2, 2398, 2405)], LATER);
    assert.deepEqual(types(r), ["EXPIRED"]);
  });

  test("an ACTIVE call never expires", () => {
    const r = evaluateCall(call({ status: "ACTIVE", enteredAt: T0 }), [candle(0, 2402, 2408)], T0 + 100 * 60 * M);
    assert.deepEqual(types(r), []);
    assert.equal(r.call.status, "ACTIVE");
  });

  test("the still-forming candle is ignored", () => {
    const r = evaluateCall(call(), [candle(0, 2399, 2406)], T0 + 10 * M);
    assert.deepEqual(types(r), []);
    assert.equal(r.call.lastCheckedAt, T0);
  });

  test("candles before the call was created are ignored", () => {
    const c = call({ createdAt: T0 + 5 * M, lastCheckedAt: T0 + 5 * M });
    const r = evaluateCall(c, [candle(0, 2395, 2402)], T0 + 20 * M);
    assert.deepEqual(types(r), []);
    assert.equal(r.call.status, "PENDING");
  });

  test("re-running is idempotent: no event is emitted twice", () => {
    const candles = [candle(0, 2399, 2406), candle(1, 2405, 2416)];
    const first = evaluateCall(call(), candles, LATER);
    assert.deepEqual(types(first), ["ENTRY", "TP1"]);
    const again = evaluateCall(first.call, candles, LATER);
    assert.deepEqual(again.events, []);
    assert.deepEqual(again.call, first.call);
    // A retry after only the first message was saved continues from there.
    const retry = evaluateCall(first.steps[0].call, candles, LATER);
    assert.deepEqual(types(retry), ["TP1"]);
  });

  test("terminal calls are never evaluated again", () => {
    const r = evaluateCall(call({ status: "SL_HIT", closedAt: T0, resultR: -1 }), [candle(0, 2399, 2430)], LATER);
    assert.deepEqual(r.events, []);
  });
});

describe("evaluateCall (SELL)", () => {
  const sell = (o: Partial<Call> = {}) => call({ side: "SELL", entry: 2400, stopLoss: 2410, tp1: 2385, tp2: 2375, ...o });

  test("entry, TP1, TP2 move downward", () => {
    const r = evaluateCall(sell(), [candle(0, 2394, 2401), candle(1, 2384, 2396), candle(2, 2374, 2390)], LATER);
    assert.deepEqual(types(r), ["ENTRY", "TP1", "TP2"]);
    assert.equal(r.call.resultR, 2.5);
  });

  test("a high above the stop is SL, and SL beats a target in the same candle", () => {
    const r = evaluateCall(sell({ status: "ACTIVE", enteredAt: T0 }), [candle(0, 2370, 2411)], LATER);
    assert.deepEqual(types(r), ["SL"]);
    assert.equal(r.call.resultR, -1);
  });
});

describe("computeStats", () => {
  const closed = (id: string, closedAt: number, over: Partial<Call>): Call => call({ id, status: "SL_HIT", closedAt, resultR: -1, ...over });
  const win = (id: string, at: number, r = 2.5) => closed(id, at, { status: "TP2_HIT", resultR: r, tp1At: at - 1 });
  const loss = (id: string, at: number) => closed(id, at, {});

  test("empty history is handled", () => {
    const s = computeStats([]);
    assert.deepEqual([s.closed, s.winRate, s.totalR, s.avgR, s.best, s.worst, s.currentStreak.type], [0, null, 0, null, null, null, "none"]);
    assert.equal(rankFor(s).name, "Rookie");
  });

  test("win rate, R totals, streaks and best/worst", () => {
    const calls = [win("A", 1, 2.5), win("B", 2, 2), loss("C", 3), win("D", 4, 3), win("E", 5, 2.5), win("F", 6, 2.5)];
    const s = computeStats(calls);
    assert.equal(s.closed, 6);
    assert.equal(s.wins, 5);
    assert.equal(s.losses, 1);
    assert.equal(s.winRate, 83.3);
    assert.equal(s.totalR, 11.5);
    assert.equal(s.avgR, 1.92);
    assert.deepEqual(s.currentStreak, { type: "win", length: 3 });
    assert.equal(s.bestWinStreak, 3);
    assert.equal(s.best?.id, "D");
    assert.equal(s.worst?.id, "C");
  });

  test("TP1 then SL counts as a win for the rate but -1R for the total", () => {
    const tp1ThenSl = closed("X", 1, { tp1At: 0 });
    assert.equal(isWin(tp1ThenSl), true);
    const s = computeStats([tp1ThenSl]);
    assert.equal(s.winRate, 100);
    assert.equal(s.totalR, -1);
  });

  test("a losing streak is reported and expired calls are counted apart", () => {
    const expired = closed("E", 9, { status: "EXPIRED", resultR: undefined });
    const s = computeStats([win("A", 1), loss("B", 2), loss("C", 3), expired]);
    assert.deepEqual(s.currentStreak, { type: "loss", length: 2 });
    assert.equal(s.expired, 1);
    assert.equal(s.closed, 3);
  });

  test("by mode and rank thresholds", () => {
    const s = computeStats([win("A", 1), closed("B", 2, { mode: "swing" })]);
    assert.deepEqual(s.byMode, { day: 1, swing: 1 });
    assert.equal(rankFor({ closed: 5, winRate: 20, totalR: -3 }).name, "Apprentice");
    assert.equal(rankFor({ closed: 15, winRate: 55, totalR: 3 }).name, "Sniper");
    assert.equal(rankFor({ closed: 15, winRate: 54, totalR: 3 }).name, "Apprentice");
    assert.equal(rankFor({ closed: 40, winRate: 60, totalR: 10 }).name, "Gold Master");
    assert.equal(rankFor({ closed: 40, winRate: 70, totalR: 5 }).name, "Sniper");
  });
});

describe("call stores", () => {
  test("fields round-trip", () => {
    const c = call({ status: "TP1_HIT", enteredAt: 5, tp1At: 6 });
    assert.deepEqual(callFromFields(callToFields(c)), c);
    assert.equal(callFromFields({ id: "x" }), null);
  });

  test("redis store: open set, closed index with pagination, 90-day expiry, locks", async () => {
    const redis = createRedisEmulator();
    const store = createRedisCallStore({ url: "https://redis.example", token: "tok", fetchImpl: redis.fetchImpl });
    await store.create(call({ id: "A" }));
    await store.create(call({ id: "B", createdAt: T0 + 1 }));
    assert.deepEqual((await store.listOpen()).map((c) => c.id), ["A", "B"]);

    await store.save(call({ id: "A", status: "ACTIVE", enteredAt: T0 }));
    assert.equal((await store.get("A"))?.status, "ACTIVE");

    await store.save(call({ id: "A", status: "SL_HIT", closedAt: 100, resultR: -1 }));
    await store.save(call({ id: "B", status: "TP2_HIT", closedAt: 200, resultR: 2.5, tp1At: 150 }));
    assert.deepEqual(await store.listOpen(), []);
    assert.deepEqual((await store.listClosed(0, 1)).map((c) => c.id), ["B"]);
    assert.deepEqual((await store.listClosed(1, 1)).map((c) => c.id), ["A"]);
    assert.equal(await store.countClosed(), 2);
    assert.deepEqual((await store.allClosed()).map((c) => c.id), ["B", "A"]);
    assert.equal(redis.expires.get("calls:item:A"), CLOSED_TTL_SECONDS);

    assert.equal(await store.acquireLock("tracker", 60), true);
    assert.equal(await store.acquireLock("tracker", 60), false);
    await store.releaseLock("tracker");
    assert.equal(await store.acquireLock("tracker", 60), true);

    await store.remove("A");
    assert.equal(await store.get("A"), null);
    assert.equal(await store.countClosed(), 1);
  });

  test("memory store behaves the same way", async () => {
    const store = createMemoryCallStore();
    await store.create(call({ id: "A" }));
    await store.save(call({ id: "A", status: "EXPIRED", closedAt: 5 }));
    assert.equal((await store.listOpen()).length, 0);
    assert.equal(await store.countClosed(), 1);
  });
});

describe("runTracker", () => {
  const config = testConfig();
  function ctx(candles: Candle[], counter: { n: number; sizes: string[] }) {
    const { fetchImpl } = scriptedFetch([
      [
        "api.twelvedata.com",
        (url) => {
          counter.n += 1;
          counter.sizes.push(new URL(url).searchParams.get("outputsize") ?? "");
          return jsonResponse(toTwelveDataPayload(candles));
        },
      ],
    ]);
    return { config, fetchImpl, cache: new TtlCache(), timeoutMs: 1000 };
  }
  const clock = () => 0;

  test("no open calls: no candle request at all", async () => {
    const counter = { n: 0, sizes: [] as string[] };
    const store = createMemoryCallStore();
    const summary = await runTracker({ store, ctx: ctx([], counter), now: LATER, clock, send: async () => undefined });
    assert.deepEqual(summary, { checked: 0, events: 0 });
    assert.equal(counter.n, 0);
  });

  test("one request for all open calls, one message per new event, state saved, nothing duplicated on re-run", async () => {
    const counter = { n: 0, sizes: [] as string[] };
    const store = createMemoryCallStore();
    await store.create(call({ id: "A" }));
    await store.create(call({ id: "B", side: "SELL", entry: 2400, stopLoss: 2410, tp1: 2385, tp2: 2375 }));
    const candles = [candle(0, 2399, 2406), candle(1, 2405, 2416)];
    const sent: string[] = [];
    const deps = { store, ctx: ctx(candles, counter), now: LATER, clock, send: async (t: string) => void sent.push(t) };
    const first = await runTracker(deps);
    assert.equal(counter.n, 1);
    assert.equal(counter.sizes[0], "500");
    assert.equal(first.checked, 2);
    assert.equal(first.events >= 3, true);
    assert.equal((await store.get("A"))?.status, "TP1_HIT");
    const sentCount = sent.length;
    const second = await runTracker(deps);
    assert.equal(second.events, 0);
    assert.equal(sent.length, sentCount);
  });

  test("closing event carries the scoreboard", async () => {
    const counter = { n: 0, sizes: [] as string[] };
    const store = createMemoryCallStore();
    await store.create(call({ id: "A", status: "ACTIVE", enteredAt: T0 }));
    const sent: string[] = [];
    await runTracker({ store, ctx: ctx([candle(0, 2380, 2402)], counter), now: LATER, clock, send: async (t) => void sent.push(t) });
    assert.match(sent[0], /SL hit/);
    assert.match(sent[0], /Win rate 0% · Total −1R/);
    assert.equal((await store.get("A"))?.status, "SL_HIT");
  });

  test("a failed send keeps earlier progress and retries the rest next run", async () => {
    const counter = { n: 0, sizes: [] as string[] };
    const store = createMemoryCallStore();
    await store.create(call({ id: "A" }));
    const candles = [candle(0, 2399, 2406), candle(1, 2405, 2416)];
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls === 2) throw new Error("telegram down");
    };
    await assert.rejects(runTracker({ store, ctx: ctx(candles, counter), now: LATER, clock, send: flaky }));
    assert.equal((await store.get("A"))?.status, "ACTIVE", "ENTRY was sent and saved, TP1 was not");
    const sent: string[] = [];
    await runTracker({ store, ctx: ctx(candles, { n: 0, sizes: [] }), now: LATER, clock, send: async (t) => void sent.push(t) });
    assert.equal(sent.length, 1);
    assert.match(sent[0], /TP1 secured/);
    assert.equal(store.locks.size, 0, "lock released after a failure");
  });

  test("an overlapping run does nothing", async () => {
    const counter = { n: 0, sizes: [] as string[] };
    const store = createMemoryCallStore();
    await store.create(call({ id: "A" }));
    await store.acquireLock("tracker", 60);
    const r = await runTracker({ store, ctx: ctx([candle(0, 2399, 2406)], counter), now: LATER, clock, send: async () => undefined });
    assert.deepEqual(r, { checked: 0, events: 0, note: "locked" });
    assert.equal(counter.n, 0);
  });

  test("candle history grows for old calls, capped at 5000", () => {
    assert.equal(candleCountFor(LATER - 60 * M, LATER), 500);
    assert.equal(candleCountFor(LATER - 10 * 24 * 60 * M, LATER), 964);
    assert.equal(candleCountFor(LATER - 400 * 24 * 60 * M, LATER), 5000);
  });
});
