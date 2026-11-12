import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  bar, confidenceMeter, escapeHtml, formatEventMessage, formatHelp, formatHistoryPage, formatNewCallMessage, formatOpenCalls, formatR,
  formatStats, historyKeyboard, ladder, navKeyboard, scoreboardLine,
} from "../lib/alerts/format";
import { TELEGRAM_MAX_TEXT, trimTelegramText } from "../lib/alerts/telegram";
import { computeStats } from "../lib/calls/stats";
import type { Call } from "../lib/calls/types";

const T0 = Date.UTC(2026, 9, 16, 10, 5);
function call(overrides: Partial<Call> = {}): Call {
  return {
    id: "ABC123", mode: "day", side: "BUY", entry: 2400, stopLoss: 2390, tp1: 2415, tp2: 2425, confidence: 80, smcVerdict: "agree",
    createdAt: T0, validUntil: T0 + 30 * 60_000, status: "PENDING", lastCheckedAt: T0, ...overrides,
  };
}
const signal = { technicalReasons: ["H4 uptrend", "H1 pullback", "RSI resets", "dropped fourth"], invalidation: "Close below 2,390", newsWarning: null, entryType: "limit" as const };

describe("formatting helpers", () => {
  test("escapeHtml", () => assert.equal(escapeHtml("a < b & c > d"), "a &lt; b &amp; c &gt; d"));

  test("meters and progress bars", () => {
    assert.equal(confidenceMeter(80), "▰▰▰▰▱");
    assert.equal(confidenceMeter(100), "▰▰▰▰▰");
    assert.equal(confidenceMeter(0), "▱▱▱▱▱");
    assert.equal(confidenceMeter(null), "▱▱▱▱▱");
    assert.equal(bar(0.5, 10), "▰▰▰▰▰▱▱▱▱▱");
    assert.equal(bar(2, 4), "▰▰▰▰");
    assert.equal(bar(-1, 4), "▱▱▱▱");
  });

  test("R formatting and ladder", () => {
    assert.equal(formatR(2.5), "+2.5R");
    assert.equal(formatR(-1), "−1R");
    assert.equal(formatR(0), "0R");
    assert.equal(ladder(call()), "⬜ Entry ▫️ ⬜ TP1 ▫️ ⬜ TP2");
    assert.equal(ladder(call({ status: "TP1_HIT", enteredAt: T0, tp1At: T0 })), "✅ Entry ▫️ ✅ TP1 ▫️ ⬜ TP2");
  });
});

describe("new-call message", () => {
  test("has the levels, planned R, meter, ladder, reasons, validity and disclaimer", () => {
    const text = formatNewCallMessage(call(), signal);
    assert.match(text, /🟢 <b>NEW CALL: XAU\/USD BUY<\/b> \(Day\) <code>#ABC123<\/code>/);
    assert.match(text, /Confidence ▰▰▰▰▱ 80\/100 · SMC: agree/);
    assert.match(text, /Entry \(limit\): <b>2,400\.00<\/b>/);
    assert.match(text, /Stop loss: 2,390\.00 \(−1R\)/);
    assert.match(text, /TP1: 2,415\.00 \(\+1\.5R\)/);
    assert.match(text, /TP2: 2,425\.00 \(\+2\.5R\)/);
    assert.match(text, /⬜ Entry ▫️ ⬜ TP1 ▫️ ⬜ TP2/);
    assert.match(text, /- RSI resets/);
    assert.ok(!text.includes("dropped fourth"));
    assert.match(text, /Entry valid until Fri 16 Oct 10:35 UTC/);
    assert.match(text, /Demo account only\. Not financial advice\./);
  });

  test("SELL uses the red marker and all dynamic text is escaped", () => {
    const text = formatNewCallMessage(call({ side: "SELL", id: "A<B&" }), { ...signal, technicalReasons: ["<script>x</script> & more"], newsWarning: "CPI <5m & NFP" });
    assert.match(text, /🔴 <b>NEW CALL: XAU\/USD SELL<\/b>/);
    assert.match(text, /#A&lt;B&amp;/);
    assert.match(text, /&lt;script&gt;x&lt;\/script&gt; &amp; more/);
    assert.match(text, /News:<\/b> CPI &lt;5m &amp; NFP/);
    assert.ok(!text.includes("<script>"));
  });
});

describe("event messages", () => {
  const active = call({ status: "ACTIVE", enteredAt: T0 + 15 * 60_000 });

  test("entry", () => {
    const text = formatEventMessage(active, { type: "ENTRY", at: T0 + 15 * 60_000 }, null);
    assert.match(text, /🎯 <b>Entry hit<\/b>/);
    assert.match(text, /▱▱▱▱▱▱▱▱▱▱ 0% to TP2/);
    assert.match(text, /⏱ 15m since the call/);
    assert.match(text, /#ABC123/);
    assert.ok(!text.includes("📊"));
  });

  test("TP1 shows the +R, the progress to TP2 and no scoreboard (the call is still open)", () => {
    const tp1 = call({ status: "TP1_HIT", enteredAt: T0, tp1At: T0 + 3_600_000 });
    const text = formatEventMessage(tp1, { type: "TP1", at: T0 + 3_600_000 }, computeStats([]));
    assert.match(text, /✅ <b>TP1 secured<\/b> \+1\.5R/);
    assert.match(text, /▰▰▰▰▰▰▱▱▱▱ 60% to TP2/);
    assert.match(text, /⏱ 1h 00m since the call/);
    assert.ok(!text.includes("📊"));
  });

  test("TP2 and SL close the call and append the scoreboard", () => {
    const won = call({ status: "TP2_HIT", enteredAt: T0, tp1At: T0, closedAt: T0 + 7_200_000, resultR: 2.5 });
    const t2 = formatEventMessage(won, { type: "TP2", at: T0 + 7_200_000 }, computeStats([won]));
    assert.match(t2, /🏆 <b>TP2 smashed<\/b> \+2\.5R/);
    assert.match(t2, /▰▰▰▰▰▰▰▰▰▰ 100% to TP2/);
    assert.match(t2, /📊 Win rate 100% · Total \+2\.5R · 🔥 1 win streak · 🌱 Rookie/);

    const lost = call({ status: "SL_HIT", enteredAt: T0, closedAt: T0 + 1_800_000, resultR: -1 });
    const sl = formatEventMessage(lost, { type: "SL", at: T0 + 1_800_000 }, computeStats([lost]));
    assert.match(sl, /🛑 <b>SL hit<\/b> −1R/);
    assert.match(sl, /🧊 1 loss streak/);
  });

  test("SL after TP1 explains the -1R", () => {
    const c = call({ status: "SL_HIT", enteredAt: T0, tp1At: T0, closedAt: T0 + 3_600_000, resultR: -1 });
    assert.match(formatEventMessage(c, { type: "SL", at: T0 + 3_600_000 }, null), /TP1 had been reached first.*−1R/);
  });

  test("expired: never entered vs void before entry; no promise of profit anywhere", () => {
    const expired = call({ status: "EXPIRED", closedAt: T0 + 30 * 60_000 });
    const text = formatEventMessage(expired, { type: "EXPIRED", at: T0 + 30 * 60_000 }, computeStats([expired]));
    assert.match(text, /⌛ <b>Expired<\/b>/);
    assert.match(text, /never reached 2,400\.00/);
    const voided = call({ status: "EXPIRED", closedAt: T0 + 15 * 60_000 });
    assert.match(formatEventMessage(voided, { type: "EXPIRED", at: T0 + 15 * 60_000 }, null), /setup is void/);
    assert.ok(!/guarantee|profit is|sure win/i.test(text));
  });

  test("scoreboard line with no history", () => {
    assert.match(scoreboardLine(computeStats([])), /No closed trades yet · 🌱 Rookie/);
  });
});

describe("command views", () => {
  const closedCall = (id: string, over: Partial<Call>) => call({ id, status: "SL_HIT", closedAt: T0 + 1000, resultR: -1, enteredAt: T0, ...over });

  test("open calls list and empty state", () => {
    assert.match(formatOpenCalls([]), /No open calls/);
    const text = formatOpenCalls([call(), call({ id: "XYZ789", status: "TP1_HIT", enteredAt: T0, tp1At: T0 })]);
    assert.match(text, /<code>#ABC123<\/code> · ⏳ Waiting for entry/);
    assert.match(text, /<code>#XYZ789<\/code> · ✅ TP1 secured/);
    assert.match(text, /Entry 2,400\.00 · SL 2,390\.00 · TP1 2,415\.00 · TP2 2,425\.00/);
    assert.match(text, /60% to TP2/);
  });

  test("history page rows and empty state", () => {
    assert.match(formatHistoryPage([], 0, 1, 0), /No closed calls yet/);
    const rows = [
      closedCall("A", { status: "TP2_HIT", resultR: 2.5, tp1At: T0 }),
      closedCall("B", { tp1At: T0 }),
      closedCall("C", {}),
      closedCall("D", { status: "EXPIRED", resultR: undefined, enteredAt: undefined }),
    ];
    const text = formatHistoryPage(rows, 1, 3, 11);
    assert.match(text, /page 2\/3/);
    assert.match(text, /🏆 TP2 · <b>\+2\.5R<\/b>/);
    assert.match(text, /🛑 SL after TP1 · <b>−1R<\/b>/);
    assert.match(text, /🛑 SL · <b>−1R<\/b>/);
    assert.match(text, /⌛ Expired · <b>no entry<\/b>/);
  });

  test("stats view and empty state", () => {
    assert.match(formatStats([]), /No closed trades yet/);
    const text = formatStats([closedCall("A", { status: "TP2_HIT", resultR: 2.5, tp1At: T0 }), closedCall("B", {})]);
    assert.match(text, /Rank: <b>Rookie<\/b>/);
    assert.match(text, /Win rate: <b>50%<\/b> \(1W \/ 1L/);
    assert.match(text, /Total: <b>\+1\.5R<\/b>/);
    assert.match(text, /Best: <code>#A<\/code> \+2\.5R/);
    assert.match(formatHelp(), /\/calls.*\n\/history.*\n\/stats/);
  });

  test("keyboards: nav row and prev/next", () => {
    assert.deepEqual(navKeyboard().inline_keyboard[0].map((b) => b.callback_data), ["calls", "h:0", "stats"]);
    assert.deepEqual(historyKeyboard(0, 3).inline_keyboard[0].map((b) => b.callback_data), ["h:1"]);
    assert.deepEqual(historyKeyboard(1, 3).inline_keyboard[0].map((b) => b.callback_data), ["h:0", "h:2"]);
    assert.deepEqual(historyKeyboard(2, 3).inline_keyboard[0].map((b) => b.callback_data), ["h:1"]);
    assert.equal(historyKeyboard(0, 1).inline_keyboard.length, 1);
  });
});

describe("trimTelegramText", () => {
  test("short text is untouched", () => assert.equal(trimTelegramText("hello"), "hello"));

  test("long multi-line HTML is cut at a line boundary under the limit with balanced tags", () => {
    const text = Array.from({ length: 600 }, (_, i) => `<b>line ${i}</b> & more`).join("\n");
    const out = trimTelegramText(text);
    assert.ok(out.length <= TELEGRAM_MAX_TEXT);
    assert.ok(out.endsWith("…"));
    assert.equal((out.match(/<b>/g) ?? []).length, (out.match(/<\/b>/g) ?? []).length);
  });

  test("a single huge line is stripped and never ends inside an entity", () => {
    const out = trimTelegramText(`<b>${"&amp;".repeat(2000)}</b>`);
    assert.ok(out.length <= TELEGRAM_MAX_TEXT);
    assert.ok(!/&[a-z#0-9]*\n…$/i.test(out));
    assert.ok(!out.includes("<"));
  });
});
