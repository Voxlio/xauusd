/** A tracked trade idea ("call"): created when an alert is sent, followed until it closes. */
import type { Mode, SmcVerdict } from "../types";

export type CallSide = "BUY" | "SELL";
export type CallStatus = "PENDING" | "ACTIVE" | "TP1_HIT" | "TP2_HIT" | "SL_HIT" | "EXPIRED";
export type CallEventType = "ENTRY" | "TP1" | "TP2" | "SL" | "EXPIRED";

export const TERMINAL_STATUSES: readonly CallStatus[] = ["TP2_HIT", "SL_HIT", "EXPIRED"];

export interface Call {
  id: string;
  mode: Mode;
  side: CallSide;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  confidence: number;
  smcVerdict: SmcVerdict;
  /** Epoch ms. */
  createdAt: number;
  validUntil: number;
  status: CallStatus;
  enteredAt?: number;
  tp1At?: number;
  closedAt?: number;
  /** Result in R: SL = -1, TP2 = reward/risk of TP2. Not set for EXPIRED. */
  resultR?: number;
  /** Candles opening at or after this time (epoch ms) have not been evaluated yet. */
  lastCheckedAt: number;
}

export interface CallEvent {
  type: CallEventType;
  /** Open time of the 15-minute candle that triggered it (validUntil for EXPIRED). */
  at: number;
}

export interface CallStep {
  event: CallEvent;
  /** The call as it looks right after this event (lastCheckedAt is not advanced yet). */
  call: Call;
}

export interface CallEvaluation {
  /** Final state, with lastCheckedAt advanced past the candles that were processed. */
  call: Call;
  events: CallEvent[];
  steps: CallStep[];
}

export function isTerminal(status: CallStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
