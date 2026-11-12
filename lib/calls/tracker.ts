/**
 * Pure call lifecycle evaluation from 15-minute candles. No I/O.
 *
 * Rules (see README "Alerts"):
 * - Only closed candles are used; a candle is processed once, from `lastCheckedAt` on.
 * - A candle's range is widened to the previous close, so gaps count as touching every price they jumped over.
 * - PENDING -> ACTIVE when a candle touches entry (only before validUntil). In that same candle only the stop is
 *   considered (entry and SL together count as SL; targets start with the next candle).
 * - Afterwards, per candle: SL first (conservative, even if a target was also touched), then TP2 (which also
 *   records TP1), then TP1. After TP1 the stop is NOT moved to breakeven.
 * - A PENDING call expires once validUntil is over and every candle before it was processed, or immediately when a
 *   candle reaches the stop level without touching entry (setup void, no trade).
 */
import { TIMEFRAME_MS } from "../config";
import type { Candle } from "../types";
import { isTerminal, type Call, type CallEvaluation, type CallEvent, type CallEventType, type CallStep } from "./types";

export const CANDLE_MS = TIMEFRAME_MS.M15;

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function riskDistance(call: Pick<Call, "entry" | "stopLoss">): number {
  return Math.abs(call.entry - call.stopLoss);
}

/** Planned reward multiple of a target, from the call's own prices. */
export function plannedR(call: Pick<Call, "entry" | "stopLoss">, target: number): number {
  const risk = riskDistance(call);
  return risk === 0 ? 0 : round2(Math.abs(target - call.entry) / risk);
}

function stopTouched(call: Call, lo: number, hi: number): boolean {
  return call.side === "BUY" ? lo <= call.stopLoss : hi >= call.stopLoss;
}

function targetTouched(call: Call, target: number, lo: number, hi: number): boolean {
  return call.side === "BUY" ? hi >= target : lo <= target;
}

export function evaluateCall(call: Call, candles: readonly Candle[], now: number): CallEvaluation {
  if (isTerminal(call.status)) return { call, events: [], steps: [] };

  const sorted = [...candles].sort((a, b) => a.time - b.time);
  let prevClose: number | null = null;
  for (const c of sorted) {
    if (c.time < call.lastCheckedAt) prevClose = c.close;
  }
  const todo = sorted.filter((c) => c.time >= call.lastCheckedAt && c.time + CANDLE_MS <= now);

  let cur: Call = { ...call };
  const events: CallEvent[] = [];
  const steps: CallStep[] = [];
  let processedUntil = call.lastCheckedAt;

  const emit = (type: CallEventType, at: number): void => {
    const event: CallEvent = { type, at };
    events.push(event);
    steps.push({ event, call: { ...cur } });
  };
  const closeSl = (at: number): void => {
    cur = { ...cur, status: "SL_HIT", closedAt: at, resultR: -1 };
    emit("SL", at);
  };

  for (const c of todo) {
    if (cur.status === "PENDING" && c.time >= cur.validUntil) break;
    const lo = prevClose === null ? c.low : Math.min(c.low, prevClose);
    const hi = prevClose === null ? c.high : Math.max(c.high, prevClose);
    prevClose = c.close;
    processedUntil = c.time + CANDLE_MS;

    if (cur.status === "PENDING") {
      if (!(lo <= cur.entry && cur.entry <= hi)) {
        // The stop level was reached without ever touching entry: the setup is void (no trade, no loss).
        if (stopTouched(cur, lo, hi)) {
          cur = { ...cur, status: "EXPIRED", closedAt: c.time };
          emit("EXPIRED", c.time);
          break;
        }
        continue;
      }
      cur = { ...cur, status: "ACTIVE", enteredAt: c.time };
      emit("ENTRY", c.time);
      if (stopTouched(cur, lo, hi)) {
        closeSl(c.time);
        break;
      }
      continue;
    }

    if (stopTouched(cur, lo, hi)) {
      closeSl(c.time);
      break;
    }
    if (cur.status === "ACTIVE" && targetTouched(cur, cur.tp1, lo, hi)) {
      cur = { ...cur, status: "TP1_HIT", tp1At: c.time };
      emit("TP1", c.time);
    }
    if (cur.status === "TP1_HIT" && targetTouched(cur, cur.tp2, lo, hi)) {
      cur = { ...cur, status: "TP2_HIT", closedAt: c.time, resultR: plannedR(cur, cur.tp2) };
      emit("TP2", c.time);
      break;
    }
  }

  if (cur.status === "PENDING" && now >= cur.validUntil + CANDLE_MS) {
    cur = { ...cur, status: "EXPIRED", closedAt: cur.validUntil };
    emit("EXPIRED", cur.validUntil);
  }

  cur = { ...cur, lastCheckedAt: Math.max(processedUntil, call.lastCheckedAt) };
  return { call: cur, events, steps };
}
