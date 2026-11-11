/** Hard gates checked in code before the AI is consulted. */
import { RULES, TIMEFRAME_MS } from "../config";
import { blockingEvents, describeEvent } from "../fundamentals";
import { goldMarketSession } from "../marketHours";
import { formatUtc } from "../time";
import type { CalendarSummary, TechnicalSummary } from "../types";

export type NewsGate = "strict" | "warn";

export interface GateInput {
  tech: TechnicalSummary;
  calendar: CalendarSummary;
  now: number;
  /** Cache state of the candles that supplied the current price. */
  priceState: "fresh" | "cache" | "stale";
  priceError: string | null;
  /** "strict": no calendar means no trade, because the 3-hour news rule cannot be checked. */
  newsGate: NewsGate;
}

/** Returns NO TRADE reasons; an empty list means the AI step may run. */
export function preTradeGates({ tech, calendar, now, priceState, priceError, newsGate }: GateInput): string[] {
  const reasons: string[] = [];

  const session = goldMarketSession(now);
  if (!session.open && session.reason) reasons.push(session.reason);

  const source = tech.timeframes.find((t) => t.role === "trigger") ?? tech.timeframes.find((t) => t.role === "setup");
  if (session.open && source) {
    const age = now - source.lastTime;
    if (age > TIMEFRAME_MS[source.timeframe] + RULES.marketClosedAfterMs) {
      reasons.push(
        `The latest ${source.timeframe} candle opened ${formatUtc(source.lastTime)}, so the gold market looks closed (holiday) or the price feed is delayed.`,
      );
    }
  }

  if (priceState === "stale") {
    reasons.push(
      `Live prices could not be refreshed${priceError ? ` (${priceError})` : ""}. No new signal is given on old prices.`,
    );
  }

  if (calendar.source === "unavailable" && newsGate === "strict") {
    reasons.push(
      "The economic calendar could not be loaded, so the 3-hour news rule cannot be checked. Set NEWS_GATE=warn to allow trades anyway.",
    );
  }

  for (const e of blockingEvents(calendar.events, now).slice(0, 3)) {
    reasons.push(`High-impact USD event within 3 hours: ${describeEvent(e, now)}.`);
  }
  return reasons;
}
