import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { checkInvariants, cleanList, cleanText, validateSignal, type SignalContext } from "../lib/signal/validate";
import { preTradeGates } from "../lib/signal/gates";
import { stopBounds } from "../lib/signal/levels";
import { summarizeCalendar, summarizeMacro } from "../lib/fundamentals";
import type { ModelSignal } from "../lib/signal/parse";
import type { EconomicEvent, MacroSeries, TechnicalSummary, TimeframeSnapshot } from "../lib/types";

const NOW = Date.UTC(2026, 9, 16, 10, 5);
const HOUR = 3_600_000;

function tf(partial: Partial<TimeframeSnapshot> & Pick<TimeframeSnapshot, "timeframe" | "role">): TimeframeSnapshot {
  return {
    bars: 500,
    lastTime: NOW - 5 * 60_000,
    close: 2400,
    ema20: 2398,
    ema50: 2392,
    ema200: 2370,
    rsi14: 58,
    macd: { macd: 1.2, signal: 0.8, histogram: 0.4, histogramPrev: 0.3 },
    atr14: 10,
    trend: "up",
    trendScore: 83,
    structure: "higher-highs-lows",
    swingHighs: [],
    swingLows: [],
    recentHigh: 2401,
    recentLow: 2397,
    supports: [],
    resistances: [],
    changePct20: 0.8,
    ...partial,
  };
}

/**
 * Price 2400, ATR 10 (H1). Nearest swing low below 2400 is 2397 (M15 recent low),
 * nearest swing high above is 2401 (M15 recent high), so the 1 ATR rule binds.
 */
function techFixture(mod: (t: TechnicalSummary) => void = () => {}): TechnicalSummary {
  const t: TechnicalSummary = {
    mode: "day",
    price: 2400,
    priceTime: NOW - 5 * 60_000,
    priceTimeframe: "M15",
    setupTimeframe: "H1",
    atr: 10,
    alignment: { up: 3, down: 0, range: 0 },
    timeframes: [
      tf({ timeframe: "M15", role: "trigger", atr14: 3, swingLows: [2396, 2390], swingHighs: [2404, 2410] }),
      tf({
        timeframe: "H1",
        role: "setup",
        swingLows: [2392, 2380],
        swingHighs: [2412, 2420],
        recentLow: 2395,
        recentHigh: 2403,
        supports: [{ price: 2385, touches: 2 }],
        resistances: [{ price: 2450, touches: 2 }],
      }),
      tf({ timeframe: "H4", role: "trend", atr14: 25, supports: [{ price: 2350, touches: 3 }], resistances: [{ price: 2480, touches: 3 }] }),
    ],
  };
  mod(t);
  return t;
}

function ctxFor(tech: TechnicalSummary, opts: { events?: EconomicEvent[]; tilt?: "bullish" | "bearish"; calendarDown?: boolean } = {}): SignalContext {
  const ry = (change5: number): MacroSeries => ({
    id: "DFII10",
    label: "ry",
    value: 1.8,
    date: "2026-10-15",
    change5,
    change20: null,
    changePct5: null,
    changePct20: null,
  });
  const macro =
    opts.tilt === "bullish" ? summarizeMacro(ry(-0.2), null) : opts.tilt === "bearish" ? summarizeMacro(ry(0.2), null) : summarizeMacro(null, null);
  const calendar = opts.calendarDown
    ? summarizeCalendar([], NOW, "unavailable", "all sources down")
    : summarizeCalendar(opts.events ?? [], NOW, "finnhub", null);
  return { tech, macro, calendar, now: NOW };
}

function model(partial: Partial<ModelSignal> = {}): ModelSignal {
  return {
    bias: "BUY",
    confidence: 65,
    entry: 2400,
    stopLoss: 2388,
    takeProfit1: 2420,
    takeProfit2: 2436,
    technicalReasons: ["H1 uptrend with higher lows", "RSI 58 on H1"],
    fundamentalReasons: ["Real yields steady"],
    invalidation: "An H1 close below 2388.",
    newsWarning: null,
    ...partial,
  };
}

const event = (title: string, offset: number): EconomicEvent => ({
  time: NOW + offset,
  title,
  country: "US",
  impact: "high",
  source: "finnhub",
  forecast: null,
  previous: null,
});

describe("validateSignal: accepted proposals", () => {
  test("a compliant BUY passes unchanged", () => {
    const s = validateSignal(model(), ctxFor(techFixture()));
    assert.equal(s.bias, "BUY");
    assert.equal(s.entry, 2400);
    assert.equal(s.stopLoss, 2388);
    assert.equal(s.takeProfit1, 2420);
    assert.equal(s.takeProfit2, 2436);
    assert.equal(s.riskUsd, 12);
    assert.equal(s.stopAtr, 1.2);
    assert.equal(s.riskReward1, 1.67);
    assert.equal(s.riskReward2, 3);
    assert.equal(s.entryType, "market");
    assert.deepEqual(s.corrections, []);
    assert.equal(s.confidence, 65);
    assert.equal(s.decidedBy, "ai");
    assert.equal(s.invalidation, "An H1 close below 2388.");
  });

  test("a compliant SELL passes unchanged", () => {
    const s = validateSignal(
      model({ bias: "SELL", entry: 2401, stopLoss: 2414, takeProfit1: 2380, takeProfit2: 2365, confidence: 60 }),
      ctxFor(techFixture((t) => (t.timeframes[2].trend = "down"))),
    );
    assert.equal(s.bias, "SELL");
    assert.equal(s.stopLoss, 2414);
    // Selling above the current price is a sell-limit order.
    assert.equal(s.entryType, "limit");
    assert.deepEqual(checkInvariants(s, techFixture()), []);
  });

  test("entry type: limit below price for a BUY, stop above", () => {
    assert.equal(validateSignal(model({ entry: 2397, stopLoss: 2385, takeProfit1: 2420, takeProfit2: 2430 }), ctxFor(techFixture())).entryType, "limit");
    assert.equal(validateSignal(model({ entry: 2404, stopLoss: 2392, takeProfit1: 2425, takeProfit2: 2440 }), ctxFor(techFixture())).entryType, "stop");
  });
});

describe("validateSignal: stop-loss corrections", () => {
  test("too tight: widened to 1 ATR", () => {
    const s = validateSignal(model({ stopLoss: 2395 }), ctxFor(techFixture()));
    assert.equal(s.bias, "BUY");
    assert.equal(s.stopLoss, 2390);
    assert.match(s.corrections[0], /Stop moved from 2,395.00 to 2,390.00 .*1× ATR/);
    assert.match(s.invalidation, /hard stop was adjusted to 2,390.00/);
  });

  test("inside the nearest swing: moved beyond it with a 0.1 ATR buffer", () => {
    const tech = techFixture((t) => {
      t.timeframes[0] = { ...t.timeframes[0], swingLows: [2388], recentLow: 2388 };
      t.timeframes[1] = { ...t.timeframes[1], swingLows: [2370], recentLow: 2388 };
    });
    const b = stopBounds(tech, "BUY", 2400);
    assert.equal(b.nearestSwing, 2388);
    assert.equal(b.bindingRule, "swing");
    const s = validateSignal(model({ stopLoss: 2389, takeProfit1: 2430, takeProfit2: 2450 }), ctxFor(tech));
    assert.equal(s.stopLoss, 2387);
    assert.match(s.corrections[0], /beyond the nearest swing low at 2,388.00/);
    assert.ok(s.stopLoss !== null && s.stopLoss < 2388);
  });

  test("too wide: tightened to 2.5 ATR", () => {
    const s = validateSignal(model({ stopLoss: 2350, takeProfit1: 2500, takeProfit2: 2560 }), ctxFor(techFixture()));
    assert.equal(s.stopLoss, 2375);
    assert.match(s.corrections[0], /tightened/);
  });

  test("structural stop needs more than 2.5 ATR: NO TRADE", () => {
    const tech = techFixture((t) => {
      for (const f of t.timeframes) {
        f.swingLows = [2374];
        f.recentLow = 2374;
      }
    });
    const s = validateSignal(model({ stopLoss: 2380 }), ctxFor(tech));
    assert.equal(s.bias, "NO_TRADE");
    assert.match(s.noTradeReasons[0], /2\.70× ATR; the maximum is 2\.5× ATR/);
  });

  test("stop on the wrong side: NO TRADE", () => {
    const s = validateSignal(model({ stopLoss: 2410 }), ctxFor(techFixture()));
    assert.equal(s.bias, "NO_TRADE");
    assert.match(s.noTradeReasons[0], /wrong side/);
  });
});

describe("validateSignal: entry and targets", () => {
  test("entry more than 0.5 ATR from price: NO TRADE", () => {
    const s = validateSignal(model({ entry: 2394, stopLoss: 2380, takeProfit1: 2420, takeProfit2: 2440 }), ctxFor(techFixture()));
    assert.equal(s.bias, "NO_TRADE");
    assert.match(s.noTradeReasons[0], /0\.60× ATR .*limit is 0\.5× ATR/);
    assert.equal(s.entry, null);
  });

  test("entry exactly 0.5 ATR away is allowed", () => {
    const s = validateSignal(model({ entry: 2395, stopLoss: 2383, takeProfit1: 2420, takeProfit2: 2430 }), ctxFor(techFixture()));
    assert.equal(s.bias, "BUY");
  });

  test("TP1 below 1.5R and TP2 below 2.5R are extended", () => {
    const s = validateSignal(model({ takeProfit1: 2410, takeProfit2: 2420 }), ctxFor(techFixture()));
    assert.equal(s.bias, "BUY");
    assert.equal(s.takeProfit1, 2418);
    assert.equal(s.takeProfit2, 2430);
    assert.equal(s.riskReward1, 1.5);
    assert.equal(s.riskReward2, 2.5);
    assert.equal(s.corrections.length, 2);
  });

  test("TP2 keeps at least 0.5R beyond TP1", () => {
    const s = validateSignal(model({ takeProfit1: 2430, takeProfit2: 2431 }), ctxFor(techFixture()));
    assert.equal(s.takeProfit1, 2430);
    assert.equal(s.takeProfit2, 2436);
  });

  test("swapped targets are re-ordered", () => {
    const s = validateSignal(model({ takeProfit1: 2436, takeProfit2: 2420 }), ctxFor(techFixture()));
    assert.equal(s.takeProfit1, 2420);
    assert.equal(s.takeProfit2, 2436);
    assert.match(s.corrections[0], /swapped/);
  });

  test("absurd targets are capped at 6R / 10R", () => {
    const s = validateSignal(model({ takeProfit1: 2800, takeProfit2: 2850 }), ctxFor(techFixture()));
    assert.equal(s.bias, "NO_TRADE", "levels >15% away are discarded first");
    const capped = validateSignal(model({ takeProfit1: 2500, takeProfit2: 2600 }), ctxFor(techFixture()));
    assert.equal(capped.takeProfit1, 2472);
    assert.equal(capped.takeProfit2, 2520);
  });

  test("rounding never shrinks R below the minimum", () => {
    const tech = techFixture((t) => (t.atr = 10.37));
    const s = validateSignal(model({ entry: 2400.01, stopLoss: 2395, takeProfit1: 2401, takeProfit2: 2402 }), ctxFor(tech));
    assert.equal(s.bias, "BUY");
    assert.ok((s.riskReward1 ?? 0) >= 1.5);
    assert.deepEqual(checkInvariants(s, tech), []);
  });

  test("target on the wrong side: NO TRADE", () => {
    const s = validateSignal(model({ takeProfit1: 2390 }), ctxFor(techFixture()));
    assert.equal(s.bias, "NO_TRADE");
    assert.match(s.noTradeReasons[0], /take-profit is on the wrong side/);
  });

  test("missing or implausible numbers: NO TRADE without numbers", () => {
    const missing = validateSignal(model({ stopLoss: null, takeProfit2: null }), ctxFor(techFixture()));
    assert.equal(missing.bias, "NO_TRADE");
    assert.match(missing.noTradeReasons[0], /stopLoss, takeProfit2/);
    const far = validateSignal(model({ entry: 1900 }), ctxFor(techFixture()));
    assert.equal(far.bias, "NO_TRADE");
    assert.equal(far.stopLoss, null);
  });

  test("resistance before TP1 produces a warning", () => {
    const tech = techFixture((t) => (t.timeframes[1].resistances = [{ price: 2410, touches: 3 }]));
    const s = validateSignal(model(), ctxFor(tech));
    assert.equal(s.bias, "BUY");
    assert.match(s.warnings.join(" "), /Resistance at 2,410.00 \(H1, 3 touches\) sits before TP1/);
  });
});

describe("validateSignal: news, model NO TRADE and confidence", () => {
  test("high-impact USD event within 3 hours forces NO TRADE", () => {
    const s = validateSignal(model(), ctxFor(techFixture(), { events: [event("CPI m/m", 2 * HOUR)] }));
    assert.equal(s.bias, "NO_TRADE");
    assert.match(s.noTradeReasons[0], /CPI m\/m in 2h 00m/);
    assert.match(s.newsWarning ?? "", /within 3 hours/);
    assert.equal(s.entry, null);
  });

  test("an event 4 hours out only warns", () => {
    const s = validateSignal(model(), ctxFor(techFixture(), { events: [event("FOMC", 4 * HOUR)] }));
    assert.equal(s.bias, "BUY");
    assert.match(s.newsWarning ?? "", /next 48h: FOMC in 4h 00m/);
  });

  test("model NO_TRADE is passed through with its reasons", () => {
    const s = validateSignal(model({ bias: "NO_TRADE", entry: null, stopLoss: null, technicalReasons: ["Timeframes conflict"] }), ctxFor(techFixture()));
    assert.equal(s.bias, "NO_TRADE");
    assert.equal(s.decidedBy, "ai");
    assert.deepEqual(s.technicalReasons, ["Timeframes conflict"]);
  });

  test("counter-trend and macro conflicts lower confidence", () => {
    const tech = techFixture((t) => (t.timeframes[2].trend = "down"));
    const s = validateSignal(model({ confidence: 70 }), ctxFor(tech));
    assert.equal(s.confidence, 55);
    assert.match(s.corrections.join(" "), /against the H4 downtrend \(−15\)/);

    const both = validateSignal(model({ confidence: 60 }), ctxFor(tech, { tilt: "bearish" }));
    assert.equal(both.bias, "NO_TRADE");
    assert.match(both.noTradeReasons[0], /drops to 35 .*below the minimum of 40/);
  });

  test("unavailable calendar lowers confidence and warns", () => {
    const s = validateSignal(model({ confidence: 65 }), ctxFor(techFixture(), { calendarDown: true }));
    assert.equal(s.confidence, 55);
    assert.match(s.newsWarning ?? "", /unavailable/);
  });

  test("missing trend timeframe lowers confidence", () => {
    const tech = techFixture((t) => (t.timeframes = t.timeframes.filter((f) => f.role !== "trend")));
    const s = validateSignal(model({ confidence: 65 }), ctxFor(tech));
    assert.equal(s.confidence, 55);
    assert.match(s.corrections.join(" "), /higher-timeframe trend unavailable \(−10\)/);
  });

  test("missing confidence assumes 50 and says so", () => {
    const s = validateSignal(model({ confidence: null }), ctxFor(techFixture()));
    assert.equal(s.confidence, 50);
    assert.match(s.warnings.join(" "), /50 was assumed/);
  });
});

describe("text cleaning", () => {
  test("strips control characters, collapses whitespace and caps length", () => {
    assert.equal(cleanText("  a\u0000b\n\n c  ", 50), "a b c");
    assert.equal(cleanText("x".repeat(300), 10).length, 10);
    assert.deepEqual(cleanList(["", "  ", "a", "b", "c", "d", "e", "f"]), ["a", "b", "c", "d", "e"]);
  });
});

describe("pre-trade gates", () => {
  const calendar = summarizeCalendar([], NOW, "finnhub", null);
  const gate = (over: Partial<Parameters<typeof preTradeGates>[0]> = {}) =>
    preTradeGates({ tech: techFixture(), calendar, now: NOW, priceState: "fresh", priceError: null, newsGate: "strict", ...over });

  test("open market with fresh prices passes", () => {
    assert.deepEqual(gate(), []);
  });

  test("stale feed during trading hours blocks", () => {
    const reasons = gate({ now: NOW + 3 * HOUR });
    assert.match(reasons[0], /looks closed \(holiday\) or the price feed is delayed/);
  });

  test("Friday after the close blocks even though the last candle is recent", () => {
    // Fri 16 Oct 2026 21:15 UTC = 17:15 New York; last M15 bar opened 20:45 UTC.
    const fridayClose = Date.UTC(2026, 9, 16, 21, 15);
    const tech = techFixture((t) => t.timeframes.forEach((f) => (f.lastTime = Date.UTC(2026, 9, 16, 20, 45))));
    const reasons = gate({ tech, now: fridayClose });
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /closed for the weekend/);
  });

  test("stale cached prices block", () => {
    const reasons = gate({ priceState: "stale", priceError: "rate limit" });
    assert.match(reasons[0], /could not be refreshed \(rate limit\)/);
  });

  test("news within 3 hours blocks", () => {
    const busy = summarizeCalendar([event("NFP", HOUR)], NOW, "finnhub", null);
    assert.match(gate({ calendar: busy, priceState: "cache" })[0], /NFP in 1h 00m/);
  });

  test("no calendar: strict blocks, warn allows", () => {
    const down = summarizeCalendar([], NOW, "unavailable", "all sources down");
    assert.match(gate({ calendar: down })[0], /cannot be checked.*NEWS_GATE=warn/);
    assert.deepEqual(gate({ calendar: down, newsGate: "warn" }), []);
  });
});

/** Seeded PRNG (mulberry32) so the fuzz run is reproducible. */
function prng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("fuzz: no published BUY/SELL ever breaks a rule", () => {
  test("4,000 random proposals", () => {
    const rand = prng(42);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
    let published = 0;
    for (let i = 0; i < 4000; i++) {
      const atr = 2 + rand() * 30;
      const price = 1500 + rand() * 2500;
      const tech = techFixture((t) => {
        t.price = Math.round(price * 100) / 100;
        t.atr = Math.round(atr * 100) / 100;
        for (const f of t.timeframes) {
          f.swingLows = [price - rand() * 3 * atr, price - rand() * 3 * atr];
          f.swingHighs = [price + rand() * 3 * atr, price + rand() * 3 * atr];
          f.recentLow = price - rand() * atr;
          f.recentHigh = price + rand() * atr;
          f.trend = pick(["up", "down", "range"] as const);
        }
      });
      const bias = pick(["BUY", "SELL", "NO_TRADE"] as const);
      const dir = bias === "SELL" ? -1 : 1;
      const entry = price + (rand() - 0.5) * 2 * atr;
      const proposal = model({
        bias,
        confidence: Math.round(rand() * 100),
        entry: rand() < 0.03 ? null : entry,
        stopLoss: entry - dir * (rand() * 4 - 0.5) * atr,
        takeProfit1: entry + dir * (rand() * 8 - 1) * atr,
        takeProfit2: entry + dir * (rand() * 12 - 1) * atr,
      });
      const events = rand() < 0.1 ? [event("CPI", rand() * 6 * HOUR)] : [];
      const ctx = ctxFor(tech, { events, tilt: pick(["bullish", "bearish", undefined] as const) });
      const s = validateSignal(proposal, ctx);

      if (s.bias === "NO_TRADE") {
        assert.equal(s.entry, null);
        assert.equal(s.stopLoss, null);
        assert.equal(s.takeProfit1, null);
        assert.equal(s.takeProfit2, null);
        assert.ok(s.noTradeReasons.length > 0);
        continue;
      }
      published += 1;
      assert.deepEqual(checkInvariants(s, tech), [], `case ${i}: ${JSON.stringify({ proposal, s })}`);
      assert.ok(Math.abs((s.entry ?? 0) - tech.price) <= 0.5 * tech.atr + 0.005);
      assert.ok((s.stopAtr ?? 0) >= 0.999 && (s.stopAtr ?? 0) <= 2.501);
      assert.ok((s.riskReward1 ?? 0) >= 1.5 && (s.riskReward2 ?? 0) >= 2.5);
      assert.ok((s.confidence ?? 0) >= 40);
      assert.equal(blockingCount(ctx), 0);
      for (const p of [s.entry, s.stopLoss, s.takeProfit1, s.takeProfit2]) {
        assert.equal(Math.round((p ?? 0) * 100) / 100, p, "prices are in whole cents");
      }
    }
    assert.ok(published > 100, `expected a meaningful number of published signals, got ${published}`);
  });
});

function blockingCount(ctx: SignalContext): number {
  return ctx.calendar.events.filter((e) => e.time >= ctx.now - 15 * 60_000 && e.time <= ctx.now + 3 * HOUR).length;
}
