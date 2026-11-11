/**
 * Pure fundamental analysis helpers: macro tilt for gold, calendar windows and
 * news warnings. Tested in tests/fundamentals.test.ts.
 */
import { RULES } from "./config";
import { round } from "./num";
import { formatCountdown, formatUtc } from "./time";
import type { CalendarSource, CalendarSummary, EconomicEvent, MacroSeries, MacroSummary, MacroTilt } from "./types";

/** A 5-observation move of at least this size counts as meaningful. */
export const REAL_YIELD_THRESHOLD_PCT_POINTS = 0.05; // 5 bp
export const USD_THRESHOLD_PCT = 0.3;

function signed(value: number, decimals: number, suffix: string): string {
  const v = round(value, decimals);
  return `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toFixed(decimals)}${suffix}`;
}

export function summarizeMacro(realYield: MacroSeries | null, usdIndex: MacroSeries | null): MacroSummary {
  const notes: string[] = [];
  let votes = 0;
  let available = 0;

  if (realYield) {
    available += 1;
    const c5 = realYield.change5;
    let effect = "little change for gold";
    if (c5 !== null && c5 <= -REAL_YIELD_THRESHOLD_PCT_POINTS) {
      votes += 1;
      effect = "falling real yields support gold";
    } else if (c5 !== null && c5 >= REAL_YIELD_THRESHOLD_PCT_POINTS) {
      votes -= 1;
      effect = "rising real yields weigh on gold";
    }
    const moves = [
      c5 !== null ? `${signed(c5 * 100, 0, " bp")} over 5 sessions` : null,
      realYield.change20 !== null ? `${signed(realYield.change20 * 100, 0, " bp")} over 20` : null,
    ].filter(Boolean);
    notes.push(
      `US 10Y real yield ${realYield.value.toFixed(2)}% as of ${realYield.date}${moves.length ? ` (${moves.join(", ")})` : ""}: ${effect}.`,
    );
  }

  if (usdIndex) {
    available += 1;
    const p5 = usdIndex.changePct5;
    let effect = "little change for gold";
    if (p5 !== null && p5 <= -USD_THRESHOLD_PCT) {
      votes += 1;
      effect = "a softer dollar supports gold";
    } else if (p5 !== null && p5 >= USD_THRESHOLD_PCT) {
      votes -= 1;
      effect = "a firmer dollar weighs on gold";
    }
    const moves = [
      p5 !== null ? `${signed(p5, 2, "%")} over 5 obs` : null,
      usdIndex.changePct20 !== null ? `${signed(usdIndex.changePct20, 2, "%")} over 20` : null,
    ].filter(Boolean);
    notes.push(
      `Broad dollar index ${usdIndex.value.toFixed(2)} as of ${usdIndex.date}${moves.length ? ` (${moves.join(", ")})` : ""}: ${effect}.`,
    );
  }

  const tilt: MacroTilt = available === 0 ? "unknown" : votes > 0 ? "bullish" : votes < 0 ? "bearish" : "neutral";
  if (available === 0) notes.push("Macro data unavailable; fundamentals are limited to the economic calendar.");
  return { realYield, usdIndex, tilt, notes };
}

/** High-impact US events from 15 minutes ago up to 48 hours ahead, de-duplicated, soonest first. */
export function summarizeCalendar(
  events: readonly EconomicEvent[],
  now: number,
  source: CalendarSource,
  note: string | null,
): CalendarSummary {
  const seen = new Set<string>();
  const window = events
    .filter((e) => e.time >= now - RULES.newsBlockBehindMs && e.time <= now + RULES.newsWindowMs)
    .filter((e) => {
      const key = `${e.time}|${e.title.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.time - b.time);
  return { source, events: window, note };
}

/** Events that block new trades: within 15 minutes after or 3 hours before release. */
export function blockingEvents(events: readonly EconomicEvent[], now: number): EconomicEvent[] {
  return events.filter((e) => e.time >= now - RULES.newsBlockBehindMs && e.time <= now + RULES.newsBlockAheadMs);
}

export function describeEvent(e: EconomicEvent, now: number): string {
  const when = e.time <= now ? "just released" : `in ${formatCountdown(e.time - now)}`;
  return `${e.title} ${when} (${formatUtc(e.time)})`;
}

/** Warning bar text, or null when the calendar is clear for 48h. */
export function newsWarningText(calendar: CalendarSummary, now: number): string | null {
  if (calendar.source === "unavailable") {
    return "Economic calendar unavailable. Check high-impact USD news yourself before trading.";
  }
  if (calendar.events.length === 0) return null;
  const blocking = blockingEvents(calendar.events, now);
  const listed = calendar.events.slice(0, 3).map((e) => describeEvent(e, now));
  const more = calendar.events.length > 3 ? ` +${calendar.events.length - 3} more` : "";
  if (blocking.length > 0) {
    return `High-impact USD news within 3 hours: ${listed.join("; ")}${more}. No new trades until it has passed.`;
  }
  return `High-impact USD news in the next 48h: ${listed.join("; ")}${more}.`;
}

/** Deterministic fundamental bullets used when the AI is skipped, and shown to the model as facts. */
export function fundamentalFacts(macro: MacroSummary, calendar: CalendarSummary, now: number): string[] {
  const facts = [...macro.notes];
  if (calendar.source === "unavailable") {
    facts.push("Economic calendar could not be loaded.");
  } else if (calendar.events.length === 0) {
    facts.push("No high-impact USD events in the next 48 hours.");
  } else {
    facts.push(`Next high-impact USD event: ${describeEvent(calendar.events[0], now)}.`);
  }
  return facts;
}
