/** Pure alert rules: decides whether a validated signal deserves a Telegram message. No I/O. */
import type { Bias, Mode, TechnicalSummary, ValidatedSignal } from "../types";

export interface AlertSettings {
  minConfidence: number;
  cooldownHours: number;
  sessionsOnly: boolean;
}

/** What was stored when the last alert for the same mode and side went out. */
export interface LastAlert {
  entry: number;
  /** Epoch ms when the alert was sent. */
  at: number;
  confidence: number;
}

export interface AlertDecision {
  send: boolean;
  reason: string;
}

export interface AlertInput {
  mode: Mode;
  signal: Pick<ValidatedSignal, "bias" | "confidence" | "entry" | "smcVerdict">;
  /** ATR(14) of the setup timeframe, the unit for "entry moved". */
  atr: number;
  now: number;
  last: LastAlert | null;
  settings: AlertSettings;
}

/** How long an alerted idea is considered actionable. */
export const VALID_FOR_MS: Record<Mode, number> = {
  day: 30 * 60_000,
  swing: 4 * 60 * 60_000,
};

/** London + New York hours: weekdays 07:00-20:00 UTC. */
export function isAlertSession(now: number): boolean {
  const d = new Date(now);
  const day = d.getUTCDay();
  const hour = d.getUTCHours();
  return day >= 1 && day <= 5 && hour >= 7 && hour < 20;
}

/** Equal up/down votes (including no directional vote at all) means the timeframes do not agree on anything. */
export function trendVotesFullyMixed(alignment: TechnicalSummary["alignment"]): boolean {
  return alignment.up === alignment.down;
}

export function evaluateAlert({ mode, signal, atr, now, last, settings }: AlertInput): AlertDecision {
  const side: Bias = signal.bias;
  if (side !== "BUY" && side !== "SELL") return { send: false, reason: "no_trade" };
  if (signal.confidence === null || signal.confidence < settings.minConfidence) {
    return { send: false, reason: `confidence_below_${settings.minConfidence}` };
  }
  if (signal.smcVerdict === "against") return { send: false, reason: "smc_against" };
  if (signal.entry === null) return { send: false, reason: "no_entry" };
  if (settings.sessionsOnly && !isAlertSession(now)) return { send: false, reason: "outside_session" };

  if (last && now - last.at < settings.cooldownHours * 3_600_000) {
    const moved = Math.abs(signal.entry - last.entry);
    if (!(moved > atr)) return { send: false, reason: `cooldown_${mode}_${side}` };
    return { send: true, reason: "entry_moved_over_1_atr" };
  }
  return { send: true, reason: "ok" };
}
