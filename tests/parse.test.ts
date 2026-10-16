import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { extractJsonObject, ModelOutputError, parseBias, parseConfidence, parseModelSignal, parsePrice } from "../lib/signal/parse";

const valid = {
  bias: "BUY",
  confidence: 64,
  entry: 2400.5,
  stopLoss: 2388,
  takeProfit1: 2420,
  takeProfit2: 2440,
  technicalReasons: ["H1 uptrend", "RSI 58"],
  fundamentalReasons: ["Real yields falling"],
  invalidation: "H1 close below 2388",
  newsWarning: null,
};

describe("extractJsonObject", () => {
  test("bare JSON", () => {
    assert.equal(extractJsonObject(JSON.stringify(valid)).bias, "BUY");
  });

  test("fenced JSON and surrounding prose", () => {
    assert.equal(extractJsonObject("```json\n" + JSON.stringify(valid) + "\n```").entry, 2400.5);
    assert.equal(extractJsonObject(`Here is my analysis:\n${JSON.stringify(valid)}\nGood luck!`).stopLoss, 2388);
  });

  test("braces inside strings do not confuse the scanner", () => {
    const text = `Note {draft}: ${JSON.stringify({ ...valid, invalidation: "close below {2388} level" })} trailing }`;
    assert.equal(extractJsonObject(text).invalidation, "close below {2388} level");
  });

  test("throws a ModelOutputError when there is no object", () => {
    assert.throws(() => extractJsonObject("I cannot help with that."), ModelOutputError);
    assert.throws(() => extractJsonObject("[1, 2, 3]"), ModelOutputError);
    assert.throws(() => extractJsonObject('{"bias": "BUY",'), ModelOutputError);
  });
});

describe("field parsers", () => {
  test("bias aliases", () => {
    assert.equal(parseBias("buy"), "BUY");
    assert.equal(parseBias("Long"), "BUY");
    assert.equal(parseBias("SHORT"), "SELL");
    assert.equal(parseBias("no trade"), "NO_TRADE");
    assert.equal(parseBias("No-Trade"), "NO_TRADE");
    assert.equal(parseBias("neutral"), "NO_TRADE");
    assert.throws(() => parseBias("moon"), ModelOutputError);
    assert.throws(() => parseBias(1), ModelOutputError);
  });

  test("prices accept numbers and numeric strings only", () => {
    assert.equal(parsePrice(2400.5), 2400.5);
    assert.equal(parsePrice("2,400.50"), 2400.5);
    assert.equal(parsePrice("$2400"), 2400);
    assert.equal(parsePrice("around 2400"), null);
    assert.equal(parsePrice(null), null);
    assert.equal(parsePrice(Number.NaN), null);
    assert.equal(parsePrice(Infinity), null);
  });

  test("confidence is clamped to 0-100 and fractions are scaled", () => {
    assert.equal(parseConfidence(64), 64);
    assert.equal(parseConfidence("72%"), 72);
    assert.equal(parseConfidence(0.65), 65);
    assert.equal(parseConfidence(140), 100);
    assert.equal(parseConfidence(-5), 0);
    assert.equal(parseConfidence("high"), null);
  });
});

describe("parseModelSignal", () => {
  test("parses a complete reply", () => {
    const s = parseModelSignal(JSON.stringify(valid));
    assert.equal(s.bias, "BUY");
    assert.equal(s.confidence, 64);
    assert.deepEqual(s.technicalReasons, ["H1 uptrend", "RSI 58"]);
    assert.equal(s.newsWarning, null);
  });

  test("tolerates missing optional fields and wrong list types", () => {
    const s = parseModelSignal(JSON.stringify({ bias: "NO_TRADE", technicalReasons: "Choppy H1", fundamentalReasons: [1, "USD firm"] }));
    assert.equal(s.bias, "NO_TRADE");
    assert.equal(s.entry, null);
    assert.equal(s.confidence, null);
    assert.deepEqual(s.technicalReasons, ["Choppy H1"]);
    assert.deepEqual(s.fundamentalReasons, ["USD firm"]);
    assert.equal(s.invalidation, "");
  });

  test("blank news warnings become null", () => {
    assert.equal(parseModelSignal(JSON.stringify({ ...valid, newsWarning: "  " })).newsWarning, null);
  });
});
