import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { goldMarketSession, newYorkTime } from "../lib/marketHours";

const utc = (month: number, day: number, hour: number, minute = 0) => Date.UTC(2026, month - 1, day, hour, minute);

describe("goldMarketSession (New York time, DST aware)", () => {
  test("converts UTC to New York time across the DST switch", () => {
    assert.deepEqual(newYorkTime(utc(10, 16, 21, 0)), { weekday: "Fri", hour: 17, minute: 0 }); // EDT, UTC-4
    assert.deepEqual(newYorkTime(utc(11, 6, 22, 0)), { weekday: "Fri", hour: 17, minute: 0 }); // EST, UTC-5
    assert.deepEqual(newYorkTime(utc(10, 19, 4, 0)), { weekday: "Mon", hour: 0, minute: 0 }); // midnight is 0, not 24
  });

  test("open during the week", () => {
    assert.equal(goldMarketSession(utc(10, 16, 10, 5)).open, true); // Fri 06:05 NY
    assert.equal(goldMarketSession(utc(10, 14, 3, 0)).open, true); // Tue 23:00 NY
  });

  test("weekly close: Friday 17:00 to Sunday 18:00 New York", () => {
    assert.equal(goldMarketSession(utc(10, 16, 20, 59)).open, true); // Fri 16:59 EDT
    assert.equal(goldMarketSession(utc(10, 16, 21, 0)).open, false); // Fri 17:00 EDT
    assert.equal(goldMarketSession(utc(10, 17, 12, 0)).open, false); // Saturday
    assert.equal(goldMarketSession(utc(10, 18, 21, 59)).open, false); // Sun 17:59 EDT
    assert.equal(goldMarketSession(utc(10, 18, 22, 0)).open, true); // Sun 18:00 EDT
    // Winter (EST): the close moves to 22:00 UTC.
    assert.equal(goldMarketSession(utc(11, 6, 21, 30)).open, true);
    assert.equal(goldMarketSession(utc(11, 6, 22, 0)).open, false);
    assert.match(goldMarketSession(utc(10, 17, 12, 0)).reason ?? "", /weekend/);
  });

  test("daily break 17:00-18:00 New York", () => {
    const brk = goldMarketSession(utc(10, 14, 21, 30)); // Wed 17:30 EDT
    assert.equal(brk.open, false);
    assert.match(brk.reason ?? "", /daily break/);
    assert.equal(goldMarketSession(utc(10, 14, 22, 0)).open, true);
  });
});
