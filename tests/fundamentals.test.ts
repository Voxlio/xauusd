import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  blockingEvents,
  fundamentalFacts,
  newsWarningText,
  summarizeCalendar,
  summarizeMacro,
} from "../lib/fundamentals";
import type { EconomicEvent, MacroSeries } from "../lib/types";

const now = Date.UTC(2026, 9, 16, 10, 0);
const HOUR = 3_600_000;

function event(title: string, offsetMs: number): EconomicEvent {
  return { time: now + offsetMs, title, country: "US", impact: "high", source: "finnhub", forecast: null, previous: null };
}

function series(partial: Partial<MacroSeries>): MacroSeries {
  return {
    id: "X",
    label: "X",
    value: 1,
    date: "2026-10-15",
    change5: null,
    change20: null,
    changePct5: null,
    changePct20: null,
    ...partial,
  };
}

describe("summarizeMacro", () => {
  test("falling real yields and a weaker dollar are bullish for gold", () => {
    const m = summarizeMacro(
      series({ id: "DFII10", value: 1.8, change5: -0.12 }),
      series({ id: "DTWEXBGS", value: 120, changePct5: -0.6 }),
    );
    assert.equal(m.tilt, "bullish");
    assert.equal(m.notes.length, 2);
    assert.match(m.notes[0], /−12 bp/);
  });

  test("rising real yields and a firmer dollar are bearish", () => {
    const m = summarizeMacro(series({ change5: 0.1 }), series({ changePct5: 0.5 }));
    assert.equal(m.tilt, "bearish");
  });

  test("offsetting or small moves are neutral", () => {
    assert.equal(summarizeMacro(series({ change5: -0.1 }), series({ changePct5: 0.5 })).tilt, "neutral");
    assert.equal(summarizeMacro(series({ change5: 0.01 }), null).tilt, "neutral");
  });

  test("no data is unknown", () => {
    const m = summarizeMacro(null, null);
    assert.equal(m.tilt, "unknown");
    assert.match(m.notes[0], /unavailable/);
  });
});

describe("calendar window and news gate", () => {
  const M = 60_000;
  const events = [
    event("Old news", -2 * HOUR),
    event("Just released", -10 * M),
    event("CPI m/m", 25 * M),
    event("CPI m/m", 25 * M),
    event("FOMC Statement", 2 * HOUR),
    event("Too far", 30 * HOUR),
  ];

  test("keeps 15 min back to 30 min ahead, de-duplicated and sorted", () => {
    const c = summarizeCalendar(events, now, "finnhub", null);
    assert.deepEqual(
      c.events.map((e) => e.title),
      ["Just released", "CPI m/m"],
    );
  });

  test("blocks within 30 minutes ahead and 15 minutes after a release", () => {
    const c = summarizeCalendar([...events, event("Soon", 10 * M)], now, "finnhub", null);
    assert.deepEqual(
      blockingEvents(c.events, now).map((e) => e.title),
      ["Just released", "Soon", "CPI m/m"],
    );
    assert.deepEqual(blockingEvents([event("Later", 30 * M + 60_000)], now), []);
    assert.equal(blockingEvents([event("Edge", 30 * M)], now).length, 1);
    assert.equal(blockingEvents([event("CPI m/m", 10 * M)], now).length, 1);
  });

  test("warning text: blocking, clear and unavailable", () => {
    const blocking = summarizeCalendar([event("CPI m/m", 10 * M)], now, "finnhub", null);
    assert.match(newsWarningText(blocking, now) ?? "", /within 30 minutes.*CPI m\/m in 10m.*No new trades/);

    assert.equal(newsWarningText(summarizeCalendar([], now, "finnhub", null), now), null);
    assert.match(newsWarningText(summarizeCalendar([], now, "unavailable", "down"), now) ?? "", /unavailable/);
  });

  test("fundamental facts mention the next event", () => {
    const facts = fundamentalFacts(summarizeMacro(null, null), summarizeCalendar([event("NFP", 25 * 60_000)], now, "finnhub", null), now);
    assert.match(facts[facts.length - 1], /Next high-impact USD event: NFP in 25m/);
  });
});
