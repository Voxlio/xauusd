/**
 * Runs the call tracker: loads open calls, fetches M15 candles once, evaluates each call, sends one Telegram
 * message per new event and saves progress. All I/O is injected. The caller isolates failures.
 */
import { formatEventMessage, navKeyboard } from "../alerts/format";
import type { InlineKeyboard } from "../alerts/telegram";
import { CANDLE_COUNT } from "../config";
import type { DataContext } from "../data/context";
import { fetchCandles } from "../data/twelvedata";
import { computeStats } from "./stats";
import type { CallStore } from "./store";
import { CANDLE_MS, evaluateCall } from "./tracker";

/** Twelve Data allows at most 5000 rows per request. */
export const MAX_TRACKER_CANDLES = 5000;
/** Stop sending after this long; unsent events stay unsaved and are retried by the next run. */
export const TRACKER_BUDGET_MS = 10_000;
export const TRACKER_LOCK_TTL_SECONDS = 60;

export interface TrackerDeps {
  store: CallStore;
  ctx: DataContext;
  now: number;
  clock: () => number;
  send: (text: string, replyMarkup: InlineKeyboard) => Promise<void>;
  budgetMs?: number;
}

export interface TrackerSummary {
  checked: number;
  events: number;
  /** Set when the run did nothing because another run holds the lock, or ran out of time. */
  note?: "locked" | "budget";
  error?: string;
}

/** How many M15 candles cover the oldest open call, never fewer than the standard history (so the Day pipeline can share it). */
export function candleCountFor(oldestLastCheckedAt: number, now: number): number {
  const needed = Math.ceil((now - oldestLastCheckedAt) / CANDLE_MS) + 4;
  return needed <= CANDLE_COUNT ? CANDLE_COUNT : Math.min(needed, MAX_TRACKER_CANDLES);
}

export async function runTracker(deps: TrackerDeps): Promise<TrackerSummary> {
  const { store, ctx, now, clock } = deps;
  const startedAt = clock();
  const budget = deps.budgetMs ?? TRACKER_BUDGET_MS;

  // Cheap exit first: nothing open means no candle request at all.
  const open = await store.listOpen();
  if (open.length === 0) return { checked: 0, events: 0 };

  if (!(await store.acquireLock("tracker", TRACKER_LOCK_TTL_SECONDS))) return { checked: 0, events: 0, note: "locked" };
  try {
    const oldest = Math.min(...open.map((c) => c.lastCheckedAt));
    const candles = (await fetchCandles("M15", ctx, candleCountFor(oldest, now))).value;

    let events = 0;
    for (const call of open) {
      const evaluation = evaluateCall(call, candles, now);
      for (const step of evaluation.steps) {
        if (clock() - startedAt > budget) return { checked: open.length, events, note: "budget" };
        const closes = step.event.type === "TP2" || step.event.type === "SL" || step.event.type === "EXPIRED";
        const stats = closes ? computeStats([...(await store.allClosed()).filter((c) => c.id !== call.id), step.call]) : null;
        await deps.send(formatEventMessage(step.call, step.event, stats), navKeyboard());
        await store.save(step.call);
        events += 1;
      }
      // All events for this call were sent: persist the final state (and the advanced lastCheckedAt).
      if (JSON.stringify(evaluation.call) !== JSON.stringify(call)) await store.save(evaluation.call);
    }
    return { checked: open.length, events };
  } finally {
    await store.releaseLock("tracker").catch(() => undefined);
  }
}
