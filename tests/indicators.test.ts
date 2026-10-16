import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  atr,
  classifyStructure,
  classifyTrend,
  clusterLevels,
  ema,
  findSwings,
  lastFinite,
  macd,
  rma,
  rsi,
  sma,
  supportResistance,
  trueRange,
} from "../lib/indicators";
import type { SwingPoint } from "../lib/types";
import { approx, candlesFromHighLow, T0 } from "./helpers";

// Wilder's classic RSI dataset (New Concepts in Technical Trading Systems / StockCharts).
const WILDER = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0,
  46.03, 46.41, 46.22, 45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57, 43.42, 42.66,
  43.13,
];

function assertSeries(actual: number[], expected: Array<number | null>, tolerance: number, label: string) {
  assert.equal(actual.length, expected.length, `${label}: length`);
  expected.forEach((e, i) => {
    if (e === null) assert.ok(Number.isNaN(actual[i]), `${label}[${i}] should be NaN, got ${actual[i]}`);
    else assert.ok(approx(actual[i], e, tolerance), `${label}[${i}] expected ${e}, got ${actual[i]}`);
  });
}

describe("sma / ema / rma", () => {
  test("sma averages a sliding window", () => {
    assertSeries(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4], 1e-12, "sma");
  });

  test("ema is seeded with the SMA and matches the reference implementation", () => {
    const out = ema(WILDER, 10);
    assert.ok(out.slice(0, 9).every(Number.isNaN));
    // Expected values from an independent Python implementation.
    const expected = [44.779, 44.981, 45.171727, 45.251413, 45.438429];
    expected.forEach((e, i) => assert.ok(approx(out[9 + i], e, 1e-6), `ema[${9 + i}] = ${out[9 + i]}`));
  });

  test("ema returns all NaN when there are fewer values than the period", () => {
    assert.ok(ema([1, 2], 3).every(Number.isNaN));
  });

  test("rma uses Wilder smoothing", () => {
    // seed = (2+4+6)/3 = 4; next = (4*2 + 8)/3 = 5.3333
    assertSeries(rma([2, 4, 6, 8], 3), [null, null, 4, 16 / 3], 1e-12, "rma");
  });

  test("invalid periods throw", () => {
    assert.throws(() => ema([1, 2, 3], 0), RangeError);
    assert.throws(() => sma([1, 2, 3], 1.5), RangeError);
  });
});

describe("rsi", () => {
  test("matches Wilder's dataset (14 period)", () => {
    // Reference values (independent Python implementation, full precision). StockCharts'
    // published table shows 70.53, 66.32... because it rounds intermediate averages.
    const expected = [
      70.46, 66.25, 66.48, 69.35, 66.29, 57.92, 62.88, 63.21, 56.01, 62.34, 54.67, 50.39, 40.02, 41.49, 41.9, 45.5,
      37.32, 33.09, 37.79,
    ];
    const out = rsi(WILDER, 14);
    assert.ok(out.slice(0, 14).every(Number.isNaN));
    expected.forEach((e, i) => assert.ok(approx(out[14 + i], e, 0.006), `rsi[${14 + i}] = ${out[14 + i]}`));
  });

  test("bounds: rising = 100, falling = 0, flat = 50", () => {
    const rising = Array.from({ length: 30 }, (_, i) => 100 + i);
    const falling = rising.slice().reverse();
    const flat = Array.from({ length: 30 }, () => 100);
    assert.equal(lastFinite(rsi(rising, 14)), 100);
    assert.equal(lastFinite(rsi(falling, 14)), 0);
    assert.equal(lastFinite(rsi(flat, 14)), 50);
  });

  test("needs more than `period` closes", () => {
    assert.ok(rsi([1, 2, 3], 3).every(Number.isNaN));
  });
});

describe("macd", () => {
  test("matches the reference implementation (3, 6, 4)", () => {
    const { macd: line, signal, histogram } = macd(WILDER, 3, 6, 4);
    const at = (arr: number[], i: number) => arr[i];
    assert.ok(Number.isNaN(at(line, 4)));
    assert.ok(approx(at(line, 5), 0.24791667, 1e-7));
    assert.ok(approx(at(line, 8), 0.41375744, 1e-7));
    assert.ok(approx(at(line, 32), -0.4377327, 1e-7));
    assert.ok(Number.isNaN(at(signal, 7)));
    assert.ok(approx(at(signal, 8), 0.3328404, 1e-7));
    assert.ok(approx(at(signal, 20), 0.03061759, 1e-7));
    assert.ok(approx(at(histogram, 9), 0.05584136, 1e-7));
    assert.ok(approx(at(histogram, 32), -0.00252286, 1e-7));
  });

  test("rejects fast >= slow", () => {
    assert.throws(() => macd(WILDER, 26, 12, 9), RangeError);
  });
});

describe("true range / atr", () => {
  // [open, high, low, close]
  const raw: Array<[number, number, number, number]> = [
    [10, 11, 9, 10.5],
    [10.5, 12, 10, 11.5],
    [11.5, 11.8, 10.2, 10.4],
    [10.4, 13, 10.4, 12.8],
    [12.8, 12.9, 11, 11.2],
    [11.2, 11.5, 9.5, 9.8],
    [9.8, 10.6, 9.7, 10.5],
  ];
  const candles = raw.map(([open, high, low, close], i) => ({ time: T0 + i * 60_000, open, high, low, close }));

  test("true range includes gaps from the previous close", () => {
    assertSeries(trueRange(candles), [2, 2, 1.6, 2.6, 1.9, 2.0, 0.9], 1e-9, "tr");
  });

  test("atr uses Wilder smoothing", () => {
    assertSeries(
      atr(candles, 3),
      [null, null, 1.8666666667, 2.1111111111, 2.0407407407, 2.0271604938, 1.6514403292],
      1e-9,
      "atr",
    );
  });
});

describe("swings and structure", () => {
  const candles = candlesFromHighLow([
    [10, 8],
    [11, 9],
    [12, 10],
    [15, 12],
    [12, 10],
    [11, 7],
    [13, 9],
    [14, 11],
    [18, 15],
    [14, 12],
    [13, 10],
    [12, 9],
    [13, 11],
  ]);

  test("finds fractal highs and lows and ignores unconfirmed bars", () => {
    const swings = findSwings(candles, 2).map((s) => [s.index, s.type, s.price]);
    assert.deepEqual(swings, [
      [3, "high", 15],
      [5, "low", 7],
      [8, "high", 18],
    ]);
  });

  test("equal highs are reported once", () => {
    const flatTop = candlesFromHighLow([
      [1, 0],
      [2, 1],
      [5, 4],
      [5, 4],
      [2, 1],
      [1, 0],
      [0.5, 0],
    ]);
    const highs = findSwings(flatTop, 2).filter((s) => s.type === "high");
    assert.equal(highs.length, 1);
    assert.equal(highs[0].index, 2);
  });

  const sw = (type: "high" | "low", price: number, index: number): SwingPoint => ({ type, price, index, time: index });

  test("classifies structure from the last two swings", () => {
    assert.equal(
      classifyStructure([sw("low", 10, 1), sw("high", 20, 2), sw("low", 12, 3), sw("high", 22, 4)]),
      "higher-highs-lows",
    );
    assert.equal(
      classifyStructure([sw("high", 22, 1), sw("low", 12, 2), sw("high", 20, 3), sw("low", 10, 4)]),
      "lower-highs-lows",
    );
    assert.equal(classifyStructure([sw("high", 22, 1), sw("low", 10, 2), sw("high", 24, 3), sw("low", 9, 4)]), "mixed");
    assert.equal(classifyStructure([sw("high", 22, 1), sw("low", 10, 2)]), "insufficient");
  });
});

describe("support / resistance", () => {
  test("clusters nearby swing prices and counts touches", () => {
    const levels = clusterLevels([110, 100, 100.2, 105.1, 100.4, 105], 0.5);
    assert.equal(levels.length, 3);
    assert.ok(approx(levels[0].price, 100.2, 1e-9));
    assert.equal(levels[0].touches, 3);
    assert.ok(approx(levels[1].price, 105.05, 1e-9));
    assert.equal(levels[1].touches, 2);
    assert.equal(levels[2].touches, 1);
  });

  test("splits levels around price, nearest first", () => {
    const levels = clusterLevels([95, 100, 106, 110, 120], 0.5);
    const { supports, resistances } = supportResistance(levels, 104, 2);
    assert.deepEqual(
      supports.map((l) => l.price),
      [100, 95],
    );
    assert.deepEqual(
      resistances.map((l) => l.price),
      [106, 110],
    );
  });

  test("rejects a non-positive tolerance", () => {
    assert.throws(() => clusterLevels([1, 2], 0), RangeError);
  });
});

describe("classifyTrend", () => {
  test("all bullish votes -> up / 100", () => {
    const r = classifyTrend({
      close: 110,
      ema20: 105,
      ema50: 100,
      ema200: 90,
      ema50Prev: 99,
      structure: "higher-highs-lows",
    });
    assert.deepEqual(r, { trend: "up", score: 100 });
  });

  test("all bearish votes -> down / -100", () => {
    const r = classifyTrend({ close: 80, ema20: 85, ema50: 90, ema200: 100, ema50Prev: 91, structure: "lower-highs-lows" });
    assert.deepEqual(r, { trend: "down", score: -100 });
  });

  test("conflicting votes -> range", () => {
    const r = classifyTrend({ close: 101, ema20: 100, ema50: 102, ema200: 95, ema50Prev: 103, structure: "mixed" });
    assert.equal(r.trend, "range");
    assert.ok(Math.abs(r.score) < 50);
  });

  test("works with partial data (no EMA 200)", () => {
    const r = classifyTrend({ close: 101, ema20: 100, ema50: 99, ema200: null, ema50Prev: 98, structure: "insufficient" });
    assert.deepEqual(r, { trend: "up", score: 100 });
  });

  test("exactly half the votes is still a range (trend needs a clear majority)", () => {
    // +1 close>ema20, +1 close>ema200, +1 ema20>ema50, 0 slope, 0 ema50 vs 200, 0 structure => 50
    const r = classifyTrend({
      close: 110,
      ema20: 100,
      ema50: 95,
      ema200: 95,
      ema50Prev: 95,
      structure: "mixed",
    });
    assert.deepEqual(r, { trend: "range", score: 50 });
  });

  test("differences inside the ATR band vote neutral", () => {
    // Every gap is below 0.2 * ATR (slope below 0.1 * ATR) with ATR = 1, so all votes are 0.
    const r = classifyTrend({
      close: 100.1,
      ema20: 100,
      ema50: 99.9,
      ema200: 99.95,
      ema50Prev: 99.85,
      structure: "mixed",
      atr: 1,
    });
    assert.deepEqual(r, { trend: "range", score: 0 });
  });
});

describe("classifyStructure tolerance", () => {
  const sw = (type: "high" | "low", price: number, index: number): SwingPoint => ({ type, price, index, time: index });
  test("near-equal swings are mixed, not a trend", () => {
    const swings = [sw("high", 20.06, 1), sw("low", 10.02, 2), sw("high", 20, 3), sw("low", 10, 4)];
    assert.equal(classifyStructure(swings), "lower-highs-lows");
    assert.equal(classifyStructure(swings, 0.1), "mixed");
  });
});
