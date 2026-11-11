/**
 * Risk geometry shared by the AI prompt (so the model sees the allowed ranges)
 * and the validator (which enforces them). All distances use the setup ATR.
 */
import { RULES } from "../config";
import type { TechnicalSummary } from "../types";

export type Side = "BUY" | "SELL";

export function direction(side: Side): 1 | -1 {
  return side === "BUY" ? 1 : -1;
}

/**
 * Swing prices that can protect a stop: confirmed swings on the trigger and
 * setup timeframes, plus each one's recent (not yet confirmed) extreme.
 */
export function stopReferenceLevels(tech: TechnicalSummary, side: Side): number[] {
  const levels: number[] = [];
  for (const tf of tech.timeframes) {
    if (tf.role === "trend") continue;
    if (side === "BUY") levels.push(...tf.swingLows, tf.recentLow);
    else levels.push(...tf.swingHighs, tf.recentHigh);
  }
  return levels.filter((p) => Number.isFinite(p) && p > 0);
}

/** Nearest swing low below (BUY) or swing high above (SELL) the entry. */
export function nearestSwing(tech: TechnicalSummary, side: Side, entry: number): number | null {
  const levels = stopReferenceLevels(tech, side);
  if (side === "BUY") {
    const below = levels.filter((p) => p < entry);
    return below.length > 0 ? Math.max(...below) : null;
  }
  const above = levels.filter((p) => p > entry);
  return above.length > 0 ? Math.min(...above) : null;
}

export interface StopBounds {
  nearestSwing: number | null;
  /** Smallest allowed stop distance: max(1 ATR, swing + buffer). */
  minDistance: number;
  /** Largest allowed stop distance: 2.5 ATR. */
  maxDistance: number;
  /** Which rule sets the minimum distance. */
  bindingRule: "atr" | "swing";
  feasible: boolean;
}

export function stopBounds(tech: TechnicalSummary, side: Side, entry: number): StopBounds {
  const atr = tech.atr;
  const swing = nearestSwing(tech, side, entry);
  const atrDistance = RULES.stopMinAtr * atr;
  const swingDistance = swing === null ? 0 : Math.abs(entry - swing) + RULES.swingBufferAtr * atr;
  const minDistance = Math.max(atrDistance, swingDistance);
  const maxDistance = RULES.stopMaxAtr * atr;
  return {
    nearestSwing: swing,
    minDistance,
    maxDistance,
    bindingRule: swingDistance > atrDistance ? "swing" : "atr",
    feasible: minDistance <= maxDistance + 1e-9,
  };
}

/** Allowed entry prices: current price ± 0.5 ATR. */
export function entryRange(tech: TechnicalSummary): { low: number; high: number } {
  const half = RULES.entryMaxAtr * tech.atr;
  return { low: tech.price - half, high: tech.price + half };
}
