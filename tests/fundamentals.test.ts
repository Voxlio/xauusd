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
  const events = [
    event("Old news", -2 * HOUR),
    event("Just released", -10 * 60_000),
    event("CPI m/m", 2 * HOUR + 59 * 60_000),
    event("CPI m/m", 2 * HOUR + 59 * 60_000),
    event("FOMC Statement", 30 * HOUR),
    event("Too far", 49 * HOUR),
  ];

  test("keeps 15 min back to 48h ahead, de-duplicated and sorted", () => {
    const c = summarizeCalendar(events, now, "finnhub", null);
    assert.deepEqual(
      c.events.map((e) => e.title),
      ["Just released", "CPI m/m", "FOMC Statement"],
    );
  });

  test("blocks within 3 hours ahead and 15 minutes after a release", () => {
    const c = summarizeCalendar(events, now, "finnhub", null);
    assert.deepEqual(
      blockingEvents(c.events, now).map((e) => e.title),
      ["Just released", "CPI m/m"],
    );
    assert.deepEqual(blockingEvents([event("Later", 3 * HOUR + 60_000)], now), []);
    assert.equal(blockingEvents([event("Edge", 3 * HOUR)], now).length, 1);
  });

  test("warning text: blocking, upcoming, clear and unavailable", () => {
    const blocking = summarizeCalendar([event("CPI m/m", HOUR)], now, "finnhub", null);
    assert.match(newsWarningText(blocking, now) ?? "", /within 3 hours.*CPI m\/m in 1h 00m.*No new trades/);

    const upcoming = summarizeCalendar([event("FOMC", 20 * HOUR)], now, "finnhub", null);
    assert.match(newsWarningText(upcoming, now) ?? "", /next 48h: FOMC in 20h 00m/);

    assert.equal(newsWarningText(summarizeCalendar([], now, "finnhub", null), now), null);
    assert.match(newsWarningText(summarizeCalendar([], now, "unavailable", "down"), now) ?? "", /unavailable/);
  });

  test("fundamental facts mention the next event", () => {
    const facts = fundamentalFacts(summarizeMacro(null, null), summarizeCalendar([event("NFP", 5 * HOUR)], now, "finnhub", null), now);
    assert.match(facts[facts.length - 1], /Next high-impact USD event: NFP in 5h 00m/);
  });
});
