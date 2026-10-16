import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  addEntry,
  entryFromResponse,
  HISTORY_LIMIT,
  historyStats,
  parseHistory,
  realizedR,
  removeEntry,
  serializeHistory,
  setResult,
  tp1R,
  type HistoryEntry,
} from "../lib/history";
import type { SignalResponse, ValidatedSignal } from "../lib/types";

function entry(partial: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "a",
    createdAt: "2026-10-16T10:05:00.000Z",
    mode: "day",
    bias: "BUY",
    entry: 2400,
    stopLoss: 2390,
    takeProfit1: 2415,
    takeProfit2: 2425,
    confidence: 60,
    result: "open",
    ...partial,
  };
}

describe("history stats", () => {
  test("win rate and average R over closed trades only", () => {
    const list = [
      entry({ id: "1", result: "tp" }), // +1.5R
      entry({ id: "2", result: "tp", takeProfit1: 2420 }), // +2R
      entry({ id: "3", result: "sl" }), // -1R
      entry({ id: "4", result: "open" }),
      entry({ id: "5", result: "skipped" }),
    ];
    const s = historyStats(list);
    assert.equal(s.total, 5);
    assert.equal(s.closed, 3);
    assert.equal(s.wins, 2);
    assert.equal(s.losses, 1);
    assert.equal(s.open, 1);
    assert.equal(s.skipped, 1);
    assert.equal(s.winRate, 66.7);
    assert.equal(s.totalR, 2.5);
    assert.equal(s.averageR, 0.83);
  });

  test("no closed trades: no win rate or average", () => {
    const s = historyStats([entry(), entry({ id: "b", result: "skipped" })]);
    assert.equal(s.winRate, null);
    assert.equal(s.averageR, null);
    assert.equal(s.totalR, 0);
  });

  test("R per trade works for sells", () => {
    const sell = entry({ bias: "SELL", entry: 2400, stopLoss: 2412, takeProfit1: 2382, takeProfit2: 2370 });
    assert.equal(tp1R(sell), 1.5);
    assert.equal(realizedR({ ...sell, result: "tp" }), 1.5);
    assert.equal(realizedR({ ...sell, result: "sl" }), -1);
    assert.equal(realizedR({ ...sell, result: "open" }), null);
  });
});

describe("history list operations", () => {
  test("add puts newest first, de-duplicates and caps", () => {
    let list: HistoryEntry[] = [];
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) list = addEntry(list, entry({ id: String(i) }));
    assert.equal(list.length, HISTORY_LIMIT);
    assert.equal(list[0].id, String(HISTORY_LIMIT + 4));
    list = addEntry(list, entry({ id: list[3].id, result: "tp" }));
    assert.equal(list.filter((e) => e.id === list[0].id).length, 1);
  });

  test("set result and remove", () => {
    const list = [entry({ id: "x" }), entry({ id: "y" })];
    assert.equal(setResult(list, "y", "sl")[1].result, "sl");
    assert.equal(setResult(list, "y", "sl")[0].result, "open");
    assert.deepEqual(
      removeEntry(list, "x").map((e) => e.id),
      ["y"],
    );
  });
});

describe("parseHistory", () => {
  test("round-trips valid entries", () => {
    const list = [entry({ id: "1" }), entry({ id: "2", bias: "SELL", entry: 2400, stopLoss: 2410, takeProfit1: 2385, takeProfit2: 2375 })];
    assert.deepEqual(parseHistory(serializeHistory(list)), list);
  });

  test("drops malformed, inconsistent and duplicate rows; tolerates garbage", () => {
    const raw = JSON.stringify([
      entry({ id: "ok" }),
      entry({ id: "ok" }),
      { ...entry({ id: "bad-bias" }), bias: "HOLD" },
      { ...entry({ id: "bad-price" }), entry: "2400" },
      entry({ id: "wrong-side", stopLoss: 2410 }),
      { ...entry({ id: "odd-result" }), result: "won" },
      null,
      42,
    ]);
    const parsed = parseHistory(raw);
    assert.deepEqual(
      parsed.map((e) => e.id),
      ["ok", "odd-result"],
    );
    assert.equal(parsed[1].result, "open");
    assert.deepEqual(parseHistory("{not json"), []);
    assert.deepEqual(parseHistory('{"a":1}'), []);
    assert.deepEqual(parseHistory(null), []);
  });
});

describe("entryFromResponse", () => {
  const signal = (partial: Partial<ValidatedSignal>): ValidatedSignal => ({
    bias: "BUY",
    confidence: 62,
    entry: 2400,
    entryType: "market",
    stopLoss: 2390,
    takeProfit1: 2415,
    takeProfit2: 2425,
    riskReward1: 1.5,
    riskReward2: 2.5,
    riskUsd: 10,
    stopAtr: 1,
    technicalReasons: [],
    fundamentalReasons: [],
    invalidation: "",
    newsWarning: null,
    aiNewsNote: null,
    noTradeReasons: [],
    corrections: [],
    warnings: [],
    decidedBy: "ai",
    ...partial,
  });
  const response = (s: ValidatedSignal) =>
    ({ signal: s, snapshot: { generatedAt: "2026-10-16T10:05:00.000Z", mode: "swing" } }) as unknown as SignalResponse;

  test("BUY/SELL become open history rows", () => {
    const e = entryFromResponse(response(signal({})), "id-1");
    assert.equal(e?.mode, "swing");
    assert.equal(e?.result, "open");
    assert.equal(e?.takeProfit1, 2415);
  });

  test("NO TRADE is not recorded", () => {
    assert.equal(entryFromResponse(response(signal({ bias: "NO_TRADE", entry: null })), "id-2"), null);
  });
});
