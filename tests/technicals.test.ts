import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { analyzeTimeframe, buildTechnicals, InsufficientDataError } from "../lib/technicals";
import { TIMEFRAME_MS } from "../lib/config";
import { candlesFromCloses, wave } from "./helpers";

const H1 = TIMEFRAME_MS.H1;

describe("analyzeTimeframe", () => {
  test("uptrend: EMAs stacked, trend up, levels on the correct side of price", () => {
    const candles = candlesFromCloses(wave(300, 2000, 2, 15), H1, 1);
    const s = analyzeTimeframe(candles, "H1", "setup");
    assert.equal(s.trend, "up");
    assert.ok(s.trendScore >= 50);
    assert.ok(s.ema20 !== null && s.ema50 !== null && s.ema200 !== null);
    assert.ok(s.ema20 > s.ema50 && s.ema50 > s.ema200);
    assert.ok(s.rsi14 !== null && s.rsi14 > 50);
    assert.ok(s.atr14 !== null && s.atr14 > 0);
    assert.ok(s.macd !== null);
    assert.ok(s.swingHighs.length > 0 && s.swingLows.length > 0);
    assert.ok(s.supports.every((l) => l.price < s.close));
    assert.ok(s.resistances.every((l) => l.price > s.close));
    assert.ok(s.recentLow <= s.close && s.recentHigh >= s.close);
    assert.equal(s.bars, 300);
  });

  test("downtrend: trend down", () => {
    const candles = candlesFromCloses(wave(300, 3000, -2, 15), H1, 1);
    const s = analyzeTimeframe(candles, "H1", "setup");
    assert.equal(s.trend, "down");
    assert.ok(s.trendScore <= -50);
    assert.ok(s.rsi14 !== null && s.rsi14 < 50);
  });

  test("sideways chop (small relative to ATR) is a range at every phase", () => {
    for (let n = 260; n <= 320; n += 3) {
      const candles = candlesFromCloses(wave(n, 2500, 0, 3, 3), H1, 2);
      const s = analyzeTimeframe(candles, "H1", "setup");
      assert.equal(s.trend, "range", `n=${n} score=${s.trendScore}`);
      assert.equal(s.structure, "mixed", `n=${n}`);
    }
  });

  test("trending fixtures are classified consistently at every phase", () => {
    for (let n = 250; n <= 330; n += 5) {
      assert.equal(analyzeTimeframe(candlesFromCloses(wave(n, 2000, 2, 15), H1, 1), "H1", "setup").trend, "up");
      assert.equal(analyzeTimeframe(candlesFromCloses(wave(n, 3000, -2, 15), H1, 1), "H1", "setup").trend, "down");
    }
  });

  test("EMA 200 is null with fewer than 200 bars, other indicators still computed", () => {
    const candles = candlesFromCloses(wave(120, 2000, 1, 5), H1, 1);
    const s = analyzeTimeframe(candles, "H1", "setup");
    assert.equal(s.ema200, null);
    assert.ok(s.ema50 !== null && s.rsi14 !== null && s.atr14 !== null);
  });

  test("throws InsufficientDataError below the minimum bar count", () => {
    const candles = candlesFromCloses(wave(30, 2000, 1, 5), H1, 1);
    assert.throws(() => analyzeTimeframe(candles, "H1", "setup"), InsufficientDataError);
  });

  test("swing lists are newest first", () => {
    const candles = candlesFromCloses(wave(300, 2000, 2, 15), H1, 1);
    const s = analyzeTimeframe(candles, "H1", "setup");
    // In a steady uptrend newer swing lows are higher than older ones.
    assert.ok(s.swingLows[0] > s.swingLows[s.swingLows.length - 1]);
  });
});

describe("buildTechnicals", () => {
  const m15 = candlesFromCloses(wave(300, 2000, 0.5, 4), TIMEFRAME_MS.M15, 0.5);
  const h1 = candlesFromCloses(wave(300, 2000, 2, 15), H1, 1);
  const h4 = candlesFromCloses(wave(300, 1900, 6, 30), TIMEFRAME_MS.H4, 3);

  test("day mode: price from M15, ATR from H1 (setup)", () => {
    const { summary, warnings } = buildTechnicals("day", { M15: m15, H1: h1, H4: h4 });
    assert.equal(summary.setupTimeframe, "H1");
    assert.equal(summary.price, Math.round(m15[m15.length - 1].close * 100) / 100);
    const setup = summary.timeframes.find((t) => t.timeframe === "H1");
    assert.equal(summary.atr, setup?.atr14);
    assert.deepEqual(
      summary.timeframes.map((t) => [t.timeframe, t.role]),
      [
        ["M15", "trigger"],
        ["H1", "setup"],
        ["H4", "trend"],
      ],
    );
    assert.equal(summary.alignment.up + summary.alignment.down + summary.alignment.range, 3);
    assert.deepEqual(warnings, []);
  });

  test("missing trend timeframe produces a warning, not an error", () => {
    const { summary, warnings } = buildTechnicals("day", { M15: m15, H1: h1 });
    assert.equal(summary.timeframes.length, 2);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /H4/);
  });

  test("short trigger history is skipped with a warning", () => {
    const { summary, warnings } = buildTechnicals("day", { M15: m15.slice(0, 20), H1: h1, H4: h4 });
    assert.equal(summary.timeframes.length, 2);
    assert.match(warnings[0], /M15/);
    // Falls back to the setup timeframe close for price.
    assert.equal(summary.price, summary.timeframes.find((t) => t.timeframe === "H1")?.close);
  });

  test("missing setup timeframe is fatal", () => {
    assert.throws(() => buildTechnicals("day", { M15: m15, H4: h4 }), InsufficientDataError);
  });

  test("swing mode uses H4 / D1 / W1", () => {
    const d1 = candlesFromCloses(wave(300, 1800, 3, 25), TIMEFRAME_MS.D1, 5);
    const w1 = candlesFromCloses(wave(300, 1200, 4, 40), TIMEFRAME_MS.W1, 10);
    const { summary } = buildTechnicals("swing", { H4: h4, D1: d1, W1: w1 });
    assert.equal(summary.setupTimeframe, "D1");
    assert.deepEqual(
      summary.timeframes.map((t) => t.timeframe),
      ["H4", "D1", "W1"],
    );
  });
});
