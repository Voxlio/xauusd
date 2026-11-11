import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { getSmcThresholds, getSmcPenalties } from "../lib/smc/config";
import { dealingRange } from "../lib/smc/range";
import { detectBosAndChoch } from "../lib/smc/structure";
import { detectSweep } from "../lib/smc/sweep";
import { detectFvg, fvgBetween } from "../lib/smc/fvg";
import { smaContext } from "../lib/smc/sma";
import { buildSmcSnapshot } from "../lib/smc/index";
import { applySmcFilter } from "../lib/smc/filter";
import type { Candle } from "../lib/types";
import type { ValidatedSignal } from "../lib/types";

const T0 = Date.UTC(2026, 9, 12, 0, 0, 0);
const H = 3_600_000;

function candle(time: number, open: number, high: number, low: number, close: number): Candle {
  return { time, open, high, low, close };
}
function mkCloses(closes: number[], step = H): Candle[] {
  return closes.map((c, i) => {
    const open = i === 0 ? c : closes[i - 1];
    return candle(T0 + i * step, open, Math.max(open, c) + 0.5, Math.min(open, c) - 0.5, c);
  });
}

// Precise fixture: only two swings (high 2500 at 5, low 2350 at 12), no spurious extras.
// Neighbors are strictly monotonic slopes away from the swing, not flats.
function makeRangeCandles(): Candle[] {
  const n = 20;
  const highs = Array(n).fill(0);
  const lows = Array(n).fill(0);
  const closes = Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    closes[i] = 2410 + (i - 10) * 0.1; // gentle drift, irrelevant
    highs[i] = 2418 + (i - 10) * 0.05;
    lows[i] = 2402 + (i - 10) * 0.05;
  }
  // Swing high at 5 isolated 2500
  highs[2] = 2416; highs[3] = 2417; highs[4] = 2418; highs[5] = 2500; highs[6] = 2418; highs[7] = 2417; highs[8] = 2416;
  closes[5] = 2490;
  lows[5] = 2410;
  // Swing low at 12 isolated 2350
  lows[9] = 2403; lows[10] = 2402; lows[11] = 2401; lows[12] = 2350; lows[13] = 2401; lows[14] = 2402; lows[15] = 2403;
  highs[12] = 2412;
  closes[12] = 2360;
  return highs.map((h, i) => candle(T0 + i * H, closes[i], h, lows[i], closes[i]));
}

describe("dealingRange premium/discount boundaries", () => {
  const thr = getSmcThresholds();
  test("discount <=35, premium >=65", () => {
    const candles = makeRangeCandles();
    // Dealing range = 2500 high, 2350 low (150 range). Mid 2425 = 50%
    const mid = dealingRange(candles, "H1", 2425, thr)!;
    assert.equal(mid.zone, "equilibrium");
    assert.ok(Math.abs(mid.pricePositionPct - 50) < 1);
    const low10 = dealingRange(candles, "H1", 2350 + 150 * 0.1, thr)!;
    assert.equal(low10.zone, "discount");
    const high90 = dealingRange(candles, "H1", 2350 + 150 * 0.9, thr)!;
    assert.equal(high90.zone, "premium");
    const at35 = dealingRange(candles, "H1", 2350 + 150 * 0.35, thr)!;
    assert.equal(at35.zone, "discount");
    const at65 = dealingRange(candles, "H1", 2350 + 150 * 0.65, thr)!;
    assert.equal(at65.zone, "premium");
    const justAbove35 = dealingRange(candles, "H1", 2350 + 150 * 0.36, thr)!;
    assert.equal(justAbove35.zone, "equilibrium");
    const justBelow65 = dealingRange(candles, "H1", 2350 + 150 * 0.64, thr)!;
    assert.equal(justBelow65.zone, "equilibrium");
  });
  test("pricePositionPct 0 at low, 100 at high", () => {
    const candles = makeRangeCandles();
    const atLow = dealingRange(candles, "H1", 2350, thr)!;
    assert.ok(Math.abs(atLow.pricePositionPct - 0) < 0.01);
    const atHigh = dealingRange(candles, "H1", 2500, thr)!;
    assert.ok(Math.abs(atHigh.pricePositionPct - 100) < 0.01);
  });
});

describe("BOS vs CHoCH in uptrend and downtrend", () => {
  // Uptrend fixture: clean HH/HL, strength 3, last swings are HL -> BOS bullish at tail.
  function uptrendCandles(): Candle[] {
    const n = 25;
    const highs = Array(n).fill(2415);
    const lows = Array(n).fill(2395);
    const closes = Array(n).fill(2405);
    // Swing highs: 5=2415+5, 14=2415+15 => 2420, 2430 (higher)
    // Swing lows: 9=2395-5, 18=2395 => 2390, 2395 (higher)
    // Set slopes to isolate
    for (let i = 0; i < n; i++) { highs[i] = 2416; lows[i] = 2402; closes[i] = 2408; }
    highs[2]=2412; highs[3]=2413; highs[4]=2414; highs[5]=2420; highs[6]=2414; highs[7]=2413; highs[8]=2412;
    closes[5]=2419;
    lows[6]=2400; lows[7]=2398; lows[8]=2392; lows[9]=2390; lows[10]=2392; lows[11]=2398; lows[12]=2400;
    closes[9]=2391;
    highs[11]=2424; highs[12]=2426; highs[13]=2428; highs[14]=2430; highs[15]=2428; highs[16]=2426; highs[17]=2424;
    closes[14]=2428;
    lows[15]=2400; lows[16]=2398; lows[17]=2396; lows[18]=2395; lows[19]=2396; lows[20]=2398; lows[21]=2400;
    closes[18]=2396;
    // Tail close above last high 2430 => bullish BOS, no CHoCH
    closes[24]=2435; highs[24]=2436; lows[24]=2433;
    // Keep surrounding highs/lows flat but below swing
    highs[22]=2416; highs[23]=2416; lows[22]=2402; lows[23]=2402;
    return highs.map((h, i) => candle(T0 + i * H, closes[i], h, lows[i], closes[i]));
  }
  function downtrendCandles(): Candle[] {
    const n = 25;
    const highs = Array(n).fill(2416);
    const lows = Array(n).fill(2402);
    const closes = Array(n).fill(2408);
    for (let i = 0; i < n; i++) { highs[i]=2416; lows[i]=2402; closes[i]=2408; }
    // Swing high 5=2430, 14=2420 (lower), lows 9=2400, 18=2390 (lower)
    highs[2]=2426; highs[3]=2427; highs[4]=2428; highs[5]=2430; highs[6]=2428; highs[7]=2427; highs[8]=2426;
    closes[5]=2429;
    lows[6]=2406; lows[7]=2404; lows[8]=2402; lows[9]=2400; lows[10]=2402; lows[11]=2404; lows[12]=2406;
    closes[9]=2401;
    highs[11]=2424; highs[12]=2422; highs[13]=2421; highs[14]=2420; highs[15]=2421; highs[16]=2422; highs[17]=2424;
    // ensure second high < first
    closes[14]=2419;
    lows[15]=2398; lows[16]=2396; lows[17]=2392; lows[18]=2390; lows[19]=2392; lows[20]=2394; lows[21]=2396;
    closes[18]=2391;
    closes[24]=2385; highs[24]=2386; lows[24]=2384;
    highs[22]=2416; highs[23]=2416; lows[22]=2402; lows[23]=2402;
    return highs.map((h,i)=>candle(T0+i*H, closes[i], h, lows[i], closes[i]));
  }

  test("BOS bullish in uptrend is detected", () => {
    const candles = uptrendCandles();
    const { bos, choch } = detectBosAndChoch(candles, "H1", 5);
    assert.equal(bos?.type, "BOS");
    assert.equal(bos?.direction, "bullish");
    assert.equal(choch, null);
  });
  test("CHoCH bullish in downtrend is detected", () => {
    const c = downtrendCandles();
    c[c.length - 1] = candle(T0 + 24 * H, 2435, 2436, 2433, 2435);
    // ensure highs at 22-23 don't create spurious swings above
    c[22]=candle(T0+22*H, 2408, 2416,2402,2408);
    c[23]=candle(T0+23*H, 2408, 2416,2402,2408);
    const { choch } = detectBosAndChoch(c, "H1", 5);
    assert.equal(choch?.type, "CHoCH");
    assert.equal(choch?.direction, "bullish");
  });
  test("CHoCH bearish in uptrend is detected", () => {
    const c = uptrendCandles();
    c[c.length - 1] = candle(T0 + 24 * H, 2388, 2390, 2387, 2388);
    // Keep surrounding neutral
    c[22]=candle(T0+22*H, 2408,2416,2402,2408);
    c[23]=candle(T0+23*H, 2408,2416,2402,2408);
    const { choch } = detectBosAndChoch(c, "H1", 5);
    assert.equal(choch?.type, "CHoCH");
    assert.equal(choch?.direction, "bearish");
  });
  test("BOS bearish in downtrend", () => {
    const c = downtrendCandles();
    const { bos } = detectBosAndChoch(c, "H1", 5);
    assert.equal(bos?.direction, "bearish");
  });
});

describe("Liquidity sweep: closes back inside vs beyond", () => {
  const thr = getSmcThresholds();
  test("sweep that closes back inside is detected", () => {
    const n = 20;
    const highs = Array(n).fill(2410);
    const lows = Array(n).fill(2400);
    const closes = Array(n).fill(2410);
    // Only two swings: isolated high 2430 at 5, isolated low 2390 at 12. Surroundings flat 2410/2400.
    highs[2]=2409; highs[3]=2409; highs[4]=2410; highs[5]=2430; highs[6]=2410; highs[7]=2409; highs[8]=2409;
    lows[9]=2400; lows[10]=2400; lows[11]=2400; lows[12]=2390; lows[13]=2400; lows[14]=2400; lows[15]=2400;
    // Keep 9-18 flat so no extra swing high forms
    for (let i = 9; i <= 18; i++) highs[i] = 2410;
    const candles = highs.map((h, i) => candle(T0 + i * H, closes[i], h, lows[i], closes[i]));
    const atr = 5;
    candles[19] = candle(T0 + 19 * H, 2429, 2431, 2405, 2428);
    const sweep = detectSweep(candles, "H1", atr, thr);
    assert.ok(sweep);
    assert.equal(sweep!.direction, "highs");
  });
  test("sweep that closes beyond is NOT a sweep", () => {
    const n = 20;
    const highs = Array(n).fill(2410);
    const lows = Array(n).fill(2400);
    const closes = Array(n).fill(2410);
    highs[2]=2409; highs[3]=2409; highs[4]=2410; highs[5]=2430; highs[6]=2410; highs[7]=2409; highs[8]=2409;
    lows[9]=2400; lows[10]=2400; lows[11]=2400; lows[12]=2390; lows[13]=2400; lows[14]=2400; lows[15]=2400;
    for (let i = 9; i <= 18; i++) highs[i] = 2410;
    const candles = highs.map((h, i) => candle(T0 + i * H, closes[i], h, lows[i], closes[i]));
    const atr = 5;
    candles[19] = candle(T0 + 19 * H, 2429, 2431, 2405, 2431);
    const sweep = detectSweep(candles, "H1", atr, thr);
    assert.equal(sweep, null);
  });
});

describe("FVG detection and filled gap", () => {
  const thr = getSmcThresholds();
  test("bullish FVG detected", () => {
    const candles: Candle[] = [
      candle(T0 + 0 * H, 2400, 2405, 2395, 2400),
      candle(T0 + 1 * H, 2400, 2402, 2398, 2400), // c1 high 2402
      candle(T0 + 2 * H, 2405, 2410, 2404, 2406),
      candle(T0 + 3 * H, 2406, 2412, 2406, 2410), // c3 low 2406 => gap 2402-2406 bullish
      candle(T0 + 4 * H, 2410, 2415, 2408, 2412),
    ];
    const { bullish } = detectFvg(candles, 2412, 5, thr);
    assert.ok(bullish);
    assert.equal(bullish!.direction, "bullish");
  });
  test("gap that gets filled is excluded", () => {
    const candles: Candle[] = [
      candle(T0 + 0 * H, 2400, 2405, 2395, 2400),
      candle(T0 + 1 * H, 2400, 2402, 2398, 2400),
      candle(T0 + 2 * H, 2405, 2410, 2404, 2406),
      candle(T0 + 3 * H, 2406, 2412, 2406, 2410),
      candle(T0 + 4 * H, 2410, 2415, 2408, 2412),
      candle(T0 + 5 * H, 2405, 2410, 2400, 2403), // wick through gap 2402-2406
    ];
    const { bullish } = detectFvg(candles, 2403, 5, thr);
    assert.equal(bullish, null);
  });
  test("bearish FVG between entry and TP1 is obstacle", () => {
    const gap = { direction: "bearish" as const, index: 2, top: 2430, bottom: 2420, atrDistance: 1, filled: false };
    assert.equal(fvgBetween(gap, 2410, 2440), true);
    assert.equal(fvgBetween(gap, 2445, 2460), false);
  });
});

describe("SMA cross detection and unavailable", () => {
  const thr = getSmcThresholds();
  test("golden cross within last 20", () => {
    const n = 260;
    const closes: number[] = [];
    for (let i = 0; i < n; i++) closes.push(i < 240 ? 2000 : 2100);
    const candles = mkCloses(closes, H);
    const ctx = smaContext(candles, 2100, thr);
    assert.ok(ctx.sma50 !== null && ctx.sma200 !== null);
    assert.equal(ctx.cross, "golden");
    assert.ok(ctx.crossCandlesAgo !== null && ctx.crossCandlesAgo <= 20 && ctx.crossCandlesAgo >= 0);
  });
  test("death cross", () => {
    const n = 260;
    const closes: number[] = [];
    for (let i = 0; i < n; i++) closes.push(i < 240 ? 2100 : 2000);
    const candles = mkCloses(closes, H);
    const ctx = smaContext(candles, 2000, thr);
    assert.equal(ctx.cross, "death");
  });
  test("unavailable when candles insufficient", () => {
    const candles = mkCloses(Array(30).fill(2000));
    const ctx = smaContext(candles, 2000, thr);
    assert.equal(ctx.priceVsSma50, "unavailable");
    assert.equal(ctx.priceVsSma200, "unavailable");
    assert.equal(ctx.available, false);
  });
  test("unavailable with 100 candles: sma50 available but sma200 unavailable", () => {
    const candles = mkCloses(Array(100).fill(2000));
    const ctx = smaContext(candles, 2000, thr);
    assert.notEqual(ctx.priceVsSma50, "unavailable");
    assert.equal(ctx.priceVsSma200, "unavailable");
  });
});

describe("buildSmcSnapshot unavailable when candles insufficient", () => {
  test("returns unavailable flag", () => {
    const snap = buildSmcSnapshot("day", { H1: mkCloses(Array(5).fill(2400)), H4: mkCloses(Array(5).fill(2400)) }, 2400);
    assert.equal(snap.available, false);
  });
});

describe("penalty stacking and below-40 NO TRADE", () => {
  function baseSignal(conf = 65, entry = 2400, tp1 = 2420): ValidatedSignal {
    return {
      bias: "BUY",
      confidence: conf,
      entry,
      entryType: "market",
      stopLoss: 2390,
      takeProfit1: tp1,
      takeProfit2: 2430,
      riskReward1: 2,
      riskReward2: 4,
      riskUsd: 10,
      stopAtr: 1,
      technicalReasons: ["t"],
      fundamentalReasons: ["f"],
      invalidation: "inv",
      newsWarning: null,
      aiNewsNote: null,
      noTradeReasons: [],
      corrections: [],
      warnings: [],
      decidedBy: "ai",
    };
  }
  function snapshotWith(overrides: Partial<import("../lib/smc/index").SmcSnapshot> = {}): import("../lib/smc/index").SmcSnapshot {
    return {
      available: true,
      setupTimeframe: "H1",
      trendTimeframe: "H4",
      dealingRange: { high: 2500, low: 2350, pricePositionPct: 90, zone: "premium" },
      zone: "premium",
      pricePositionPct: 90,
      structure: { bos: null, choch: { type: "CHoCH", direction: "bearish", price: 2400, candlesAgo: 3, index: 20 } },
      sweep: { direction: "highs", sweptPrice: 2450, candlesAgo: 2, index: 20 },
      fvgs: { bullish: null, bearish: { direction: "bearish", index: 10, top: 2415, bottom: 2405, atrDistance: 1, filled: false } },
      sma: { sma50: 2410, sma200: 2420, priceVsSma50: "below", priceVsSma200: "below", cross: null, crossCandlesAgo: null, available: true },
      atr: 5,
      disabled: false,
      ...overrides,
    } as import("../lib/smc/index").SmcSnapshot;
  }
  test("penalties stack (zone + choch + sweep + fvg + sma)", () => {
    const snap = snapshotWith();
    const sig = baseSignal(65, 2400, 2420);
    const res = applySmcFilter(sig, snap);
    assert.ok(res.penalties.length >= 5);
    assert.equal(res.verdict, "against");
    assert.ok(res.appliedPenaltiesTotal > 30);
  });
  test("below 40 turns into NO_TRADE", () => {
    const snap = snapshotWith();
    const sig = baseSignal(42, 2400, 2420);
    const res = applySmcFilter(sig, snap);
    assert.equal(res.signal.bias, "NO_TRADE");
    assert.equal(res.signal.confidence, null);
  });
  test("just above threshold stays trade with lowered confidence", () => {
    const snap = snapshotWith();
    const sig2 = baseSignal(85, 2400, 2420);
    const res2 = applySmcFilter(sig2, snap);
    if (res2.signal.bias === "BUY") assert.ok((res2.signal.confidence as number) < 85);
    else assert.equal(res2.signal.bias, "NO_TRADE");
  });
});

describe("SMC_ENABLED=false leaves signals exactly unchanged", () => {
  test("no penalty when disabled", () => {
    const snap: import("../lib/smc/index").SmcSnapshot = {
      available: false, setupTimeframe: "H1", trendTimeframe: "H4", dealingRange: null, zone: "unavailable", pricePositionPct: null,
      structure: { bos: null, choch: null }, sweep: null, fvgs: { bullish: null, bearish: null },
      sma: { sma50: null, sma200: null, priceVsSma50: "unavailable", priceVsSma200: "unavailable", cross: null, crossCandlesAgo: null, available: false },
      atr: null, disabled: true,
    };
    const sig: ValidatedSignal = {
      bias: "BUY", confidence: 65, entry: 2400, entryType: "market", stopLoss: 2390, takeProfit1: 2420, takeProfit2: 2430,
      riskReward1: 2, riskReward2: 4, riskUsd: 10, stopAtr: 1, technicalReasons: ["t"], fundamentalReasons: ["f"], invalidation: "inv", newsWarning: null, aiNewsNote: null, noTradeReasons: [], corrections: [], warnings: [], decidedBy: "ai",
    };
    const cfg = { enabled: false, hardBlock: false, penZone: 10, penChoch: 15, penSweep: 10, penFvg: 5, penSma: 5 };
    const res = applySmcFilter(sig, snap, getSmcThresholds(), cfg as never);
    assert.equal(res.verdict, "unavailable");
    assert.deepEqual(res.penalties, []);
    assert.equal(res.signal.bias, "BUY");
    assert.equal(res.signal.confidence, 65);
    assert.equal(res.signal.entry, 2400);
  });
});

describe("SMC_HARD_BLOCK behavior", () => {
  function snapDeep(): import("../lib/smc/index").SmcSnapshot {
    return {
      available: true, setupTimeframe: "H1", trendTimeframe: "H4",
      dealingRange: { high: 2500, low: 2350, pricePositionPct: 95, zone: "premium" },
      zone: "premium", pricePositionPct: 95,
      structure: { bos: null, choch: { type: "CHoCH", direction: "bearish", price: 2400, candlesAgo: 2, index: 20 } },
      sweep: null, fvgs: { bullish: null, bearish: null },
      sma: { sma50: null, sma200: null, priceVsSma50: "unavailable", priceVsSma200: "unavailable", cross: null, crossCandlesAgo: null, available: false },
      atr: 5, disabled: false,
    } as import("../lib/smc/index").SmcSnapshot;
  }
  test("hard block triggers NO_TRADE when deep zone + opposite CHoCH", () => {
    const thr = getSmcThresholds();
    const cfg = { enabled: true, hardBlock: true, penZone: 10, penChoch: 15, penSweep: 10, penFvg: 5, penSma: 5 };
    const sig: ValidatedSignal = {
      bias: "BUY" as const, confidence: 90, entry: 2480, entryType: "market", stopLoss: 2470, takeProfit1: 2500, takeProfit2: 2510,
      riskReward1: 2, riskReward2: 4, riskUsd: 10, stopAtr: 1, technicalReasons: ["t"], fundamentalReasons: ["f"], invalidation: "inv", newsWarning: null, aiNewsNote: null, noTradeReasons: [], corrections: [], warnings: [], decidedBy: "ai",
    };
    const res = applySmcFilter(sig, snapDeep(), thr, cfg as never);
    assert.equal(res.signal.bias, "NO_TRADE");
    assert.equal(res.hardBlocked, true);
  });
  test("hard block does not trigger when not deep", () => {
    const snap = snapDeep();
    (snap as unknown as Record<string, unknown>).pricePositionPct = 70;
    (snap as unknown as Record<string, unknown>).zone = "premium";
    (snap.dealingRange as unknown as Record<string, unknown>).pricePositionPct = 70;
    const cfg = { enabled: true, hardBlock: true, penZone: 10, penChoch: 15, penSweep: 10, penFvg: 5, penSma: 5 };
    const sig: ValidatedSignal = {
      bias: "BUY" as const, confidence: 90, entry: 2480, entryType: "market", stopLoss: 2470, takeProfit1: 2500, takeProfit2: 2510,
      riskReward1: 2, riskReward2: 4, riskUsd: 10, stopAtr: 1, technicalReasons: ["t"], fundamentalReasons: ["f"], invalidation: "inv", newsWarning: null, aiNewsNote: null, noTradeReasons: [], corrections: [], warnings: [], decidedBy: "ai",
    };
    const res = applySmcFilter(sig, snap, getSmcThresholds(), cfg as never);
    assert.notEqual(res.hardBlocked, true);
  });
});
