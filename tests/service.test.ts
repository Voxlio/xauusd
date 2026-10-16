import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { generateSignal, type ServiceDeps } from "../lib/signal/service";
import { AIError } from "../lib/ai/provider";
import { TtlCache } from "../lib/server/cache";
import { AppError } from "../lib/server/errors";
import { checkInvariants } from "../lib/signal/validate";
import { jsonResponse, scriptedFetch, testConfig, type Route } from "./fakes";
import { compliantBuy, fakeAI, finnhubRoute, fredRoute, MARKET_NOW, marketCandles, twelveDataRoute, type FakeAI } from "./market";
import type { Timeframe } from "../lib/types";

const HOUR = 3_600_000;
const candles = marketCandles();

function setup(opts: {
  ai?: FakeAI;
  events?: Array<{ event: string; time: number }>;
  tdOverrides?: Partial<Record<Timeframe, Route>>;
  config?: Parameters<typeof testConfig>[0];
  now?: number;
  clock?: () => number;
} = {}) {
  const { fetchImpl, calls } = scriptedFetch([
    ["api.twelvedata.com", twelveDataRoute(candles, opts.tdOverrides)],
    ["api.stlouisfed.org", fredRoute],
    ["finnhub.io", finnhubRoute(opts.events)],
  ]);
  const ai = opts.ai ?? fakeAI(compliantBuy);
  const deps: ServiceDeps = {
    config: testConfig(opts.config),
    fetchImpl,
    cache: new TtlCache(),
    provider: ai,
    now: () => opts.now ?? MARKET_NOW,
    clock: opts.clock,
  };
  return { deps, calls, ai };
}

describe("generateSignal", () => {
  test("happy path: validated BUY plus a full snapshot", async () => {
    const { deps, ai } = setup();
    const res = await generateSignal("day", deps);
    assert.equal(ai.calls.length, 1);
    assert.equal(res.signal.bias, "BUY", JSON.stringify(res.signal.noTradeReasons));
    assert.equal(res.signal.decidedBy, "ai");
    assert.deepEqual(
      res.snapshot.timeframes.map((t) => t.timeframe),
      ["M15", "H1", "H4"],
    );
    const tech = { ...res.snapshot, mode: "day" as const, priceTime: 0, alignment: { up: 0, down: 0, range: 0 } };
    assert.deepEqual(checkInvariants(res.signal, tech), []);
    assert.equal(res.snapshot.macro.tilt, "bullish");
    assert.equal(res.snapshot.calendar.source, "finnhub");
    assert.ok(res.snapshot.dataStatus.every((d) => d.state === "fresh"), JSON.stringify(res.snapshot.dataStatus));
    assert.equal(res.meta.provider, "fake");
    assert.ok(ai.calls[0].timeoutMs <= 6000);
    assert.ok(!ai.calls[0].user.includes('"open"'), "no raw candles in the prompt");
  });

  test("second call within 60 s reuses cached candles and macro data", async () => {
    const { deps, calls } = setup();
    await generateSignal("day", deps);
    const after = calls.length;
    await generateSignal("day", deps);
    assert.equal(calls.length, after, "no new upstream requests");
  });

  test("high-impact USD news within 3 hours: NO TRADE without calling the AI", async () => {
    const { deps, ai } = setup({ events: [{ event: "CPI m/m", time: MARKET_NOW + 2 * HOUR }] });
    const res = await generateSignal("day", deps);
    assert.equal(ai.calls.length, 0);
    assert.equal(res.signal.bias, "NO_TRADE");
    assert.equal(res.signal.decidedBy, "rules");
    assert.match(res.signal.noTradeReasons.join(" "), /CPI m\/m/);
    assert.match(res.signal.newsWarning ?? "", /within 3 hours/);
    assert.ok(res.signal.technicalReasons.length > 0, "code-generated technicals are still shown");
  });

  test("market closed (weekend): NO TRADE without calling the AI", async () => {
    const { deps, ai } = setup({ now: MARKET_NOW + 30 * HOUR });
    const res = await generateSignal("day", deps);
    assert.equal(ai.calls.length, 0);
    assert.match(res.signal.noTradeReasons[0], /closed for the weekend/);
  });

  test("calendar unavailable: strict gate blocks, warn mode trades with lower confidence", async () => {
    const strict = setup({ config: { finnhubKey: null, calendarFallback: "none" } });
    const blocked = await generateSignal("day", strict.deps);
    assert.equal(strict.ai.calls.length, 0);
    assert.match(blocked.signal.noTradeReasons.join(" "), /calendar could not be loaded/);

    const lenient = setup({ config: { finnhubKey: null, calendarFallback: "none", newsGate: "warn" } });
    const res = await generateSignal("day", lenient.deps);
    assert.equal(lenient.ai.calls.length, 1);
    assert.equal(res.signal.bias, "BUY");
    assert.equal(res.signal.confidence, 58);
    assert.match(res.signal.newsWarning ?? "", /unavailable/);
  });

  test("candles are cached for at most 120 s even with a longer CACHE_TTL_SECONDS", async () => {
    let wall = MARKET_NOW;
    const { deps, calls } = setup({ config: { cacheTtlMs: 300_000 } });
    deps.cache = new TtlCache(() => wall);
    deps.now = () => wall;
    await generateSignal("day", deps);
    const count = () => calls.filter((c) => c.url.includes("twelvedata")).length;
    assert.equal(count(), 3);
    wall += 150_000;
    await generateSignal("day", deps);
    assert.equal(count(), 6, "candles refetched after 120 s");
    assert.equal(calls.filter((c) => c.url.includes("stlouisfed")).length, 2, "macro still cached");
  });

  test("setup timeframe failure is a 502 with a rate-limit hint", async () => {
    const { deps } = setup({
      tdOverrides: { H1: () => jsonResponse({ status: "error", code: 429, message: "API credits exhausted" }) },
    });
    await assert.rejects(
      generateSignal("day", deps),
      (e: unknown) => e instanceof AppError && e.status === 502 && e.code === "MARKET_DATA_UNAVAILABLE" && /8 requests per minute/.test(e.hint ?? ""),
    );
  });

  test("trigger timeframe failure degrades gracefully", async () => {
    const { deps } = setup({ tdOverrides: { M15: () => jsonResponse({ status: "error", code: 500, message: "boom" }) } });
    const res = await generateSignal("day", deps);
    assert.equal(res.snapshot.timeframes.length, 2);
    assert.match(res.signal.warnings.join(" "), /M15 data unavailable/);
    assert.equal(res.snapshot.dataStatus.find((d) => d.name === "Twelve Data M15")?.state, "missing");
  });

  test("no FRED key: macro unknown, signal still produced", async () => {
    const { deps } = setup({ config: { fredKey: null } });
    const res = await generateSignal("day", deps);
    assert.equal(res.snapshot.macro.tilt, "unknown");
    assert.equal(res.snapshot.dataStatus.find((d) => d.name === "FRED real yield")?.state, "missing");
  });

  test("AI timeout: NO TRADE with the reason, snapshot intact", async () => {
    const { deps } = setup({
      ai: fakeAI(() => {
        throw new AIError("timeout", "Anthropic did not answer within 6.0s");
      }),
    });
    const res = await generateSignal("day", deps);
    assert.equal(res.signal.bias, "NO_TRADE");
    assert.match(res.signal.noTradeReasons[0], /AI analysis unavailable: Anthropic did not answer/);
    assert.equal(res.snapshot.timeframes.length, 3);
  });

  test("AI auth error surfaces as a configuration error without echoing the provider text", async () => {
    const { deps } = setup({
      ai: fakeAI(() => {
        throw new AIError("auth", "AI API error 401: Incorrect API key provided: sk-proj-****abcd (check OPENAI_API_KEY)", 401);
      }),
    });
    const original = console.error;
    console.error = () => {};
    try {
      await assert.rejects(
        generateSignal("day", deps),
        (e: unknown) =>
          e instanceof AppError && e.code === "AI_CONFIG" && /rejected the API key \(HTTP 401\)/.test(e.message) && !e.message.includes("abcd"),
      );
    } finally {
      console.error = original;
    }
  });

  test("unparseable AI reply: NO TRADE, no AI numbers", async () => {
    const { deps } = setup({ ai: fakeAI(() => "Gold looks bullish, buy around 2400!") });
    const res = await generateSignal("day", deps);
    assert.equal(res.signal.bias, "NO_TRADE");
    assert.equal(res.signal.entry, null);
    assert.match(res.signal.noTradeReasons[0], /valid JSON/);
  });

  test("a model that ignores the rules gets corrected, never passed through", async () => {
    const sloppy = fakeAI((req) => {
      const p = JSON.parse(req.user.slice(req.user.indexOf("\n") + 1));
      return JSON.stringify({
        bias: "BUY",
        confidence: 70,
        entry: p.price,
        stopLoss: p.price - 0.2 * p.atr.value,
        takeProfit1: p.price + 0.3 * p.atr.value,
        takeProfit2: p.price + 0.5 * p.atr.value,
        technicalReasons: ["tight scalp"],
        fundamentalReasons: [],
        invalidation: "",
        newsWarning: null,
      });
    });
    const { deps } = setup({ ai: sloppy });
    const res = await generateSignal("day", deps);
    if (res.signal.bias === "BUY") {
      assert.ok((res.signal.stopAtr ?? 0) >= 1);
      assert.ok((res.signal.riskReward1 ?? 0) >= 1.5);
      assert.ok(res.signal.corrections.length >= 2);
    } else {
      assert.ok(res.signal.noTradeReasons.length > 0);
    }
  });

  test("slow data leaves too little time: AI skipped", async () => {
    let ticks = 0;
    const { deps, ai } = setup({ clock: () => (ticks++ === 0 ? 0 : 7_500) });
    const res = await generateSignal("day", deps);
    assert.equal(ai.calls.length, 0);
    assert.match(res.signal.noTradeReasons[0], /too little time/);
  });

  test("AI timeout never exceeds the remaining budget", async () => {
    let ticks = 0;
    const { deps, ai } = setup({ clock: () => (ticks++ === 0 ? 0 : 4_000) });
    await generateSignal("day", deps);
    assert.equal(ai.calls.length, 1);
    assert.ok(ai.calls[0].timeoutMs <= 9_000 - 4_000 - 300, `timeout ${ai.calls[0].timeoutMs}`);
  });
});
