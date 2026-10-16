/**
 * Validates and corrects the model's proposal against hard risk rules.
 * Every price in the returned signal is computed or checked here, so model
 * numbers never reach the client unvalidated. Tested in tests/validate.test.ts.
 */
import { RULES } from "../config";
import { blockingEvents, describeEvent, fundamentalFacts, newsWarningText } from "../fundamentals";
import { clamp, formatPrice, round, roundAway } from "../num";
import { technicalFacts } from "./facts";
import { direction, stopBounds, type Side } from "./levels";
import type { ModelSignal } from "./parse";
import type { CalendarSummary, EntryType, MacroSummary, TechnicalSummary, ValidatedSignal } from "../types";

const MAX_REASONS = 5;
const MAX_REASON_CHARS = 220;
const MAX_INVALIDATION_CHARS = 300;
/** Levels further than this fraction from price are treated as hallucinated. */
const MAX_PRICE_DEVIATION = 0.15;
/** Half a cent: tolerance for prices that are rounded to cents. */
const HALF_CENT = 0.005;

export interface SignalContext {
  tech: TechnicalSummary;
  macro: MacroSummary;
  calendar: CalendarSummary;
  now: number;
}

export function cleanText(value: string, max: number): string {
  // Replace control characters (U+0000-U+001F, U+007F) with spaces, then collapse whitespace.
  const visible = Array.from(value, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 32 || code === 127 ? " " : ch;
  }).join("");
  const text = visible.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function cleanList(values: readonly string[], maxItems = MAX_REASONS): string[] {
  return values
    .map((v) => cleanText(v, MAX_REASON_CHARS))
    .filter((v) => v.length > 0)
    .slice(0, maxItems);
}

export interface NoTradeInput {
  ctx: SignalContext;
  reasons: string[];
  decidedBy: "ai" | "rules";
  technicalReasons?: string[];
  fundamentalReasons?: string[];
  invalidation?: string;
  aiNewsNote?: string | null;
  warnings?: string[];
}

export function noTradeSignal(input: NoTradeInput): ValidatedSignal {
  const { ctx } = input;
  return {
    bias: "NO_TRADE",
    confidence: null,
    entry: null,
    entryType: null,
    stopLoss: null,
    takeProfit1: null,
    takeProfit2: null,
    riskReward1: null,
    riskReward2: null,
    riskUsd: null,
    stopAtr: null,
    technicalReasons: input.technicalReasons?.length ? input.technicalReasons : technicalFacts(ctx.tech),
    fundamentalReasons: input.fundamentalReasons?.length
      ? input.fundamentalReasons
      : fundamentalFacts(ctx.macro, ctx.calendar, ctx.now),
    invalidation: input.invalidation || "No position is suggested. Run the analysis again when conditions change.",
    newsWarning: newsWarningText(ctx.calendar, ctx.now),
    aiNewsNote: input.aiNewsNote ?? null,
    noTradeReasons: input.reasons,
    corrections: [],
    warnings: input.warnings ?? [],
    decidedBy: input.decidedBy,
  };
}

/**
 * Final safety net: lists every hard rule a BUY/SELL signal breaks.
 * An empty list means the signal is publishable.
 */
export function checkInvariants(signal: ValidatedSignal, tech: TechnicalSummary): string[] {
  if (signal.bias === "NO_TRADE") return [];
  const { entry, stopLoss: sl, takeProfit1: tp1, takeProfit2: tp2 } = signal;
  if (entry === null || sl === null || tp1 === null || tp2 === null) return ["missing price levels"];
  const side: Side = signal.bias;
  const dir = direction(side);
  const atr = tech.atr;
  const problems: string[] = [];
  const risk = Math.abs(entry - sl);

  if (!(dir * (entry - sl) > 0 && dir * (tp1 - entry) > 0 && dir * (tp2 - tp1) > 0)) problems.push("levels out of order");
  if (Math.abs(entry - tech.price) > RULES.entryMaxAtr * atr + HALF_CENT) problems.push("entry too far from price");
  if (risk < RULES.stopMinAtr * atr - HALF_CENT) problems.push("stop closer than 1 ATR");
  if (risk > RULES.stopMaxAtr * atr + HALF_CENT) problems.push("stop wider than 2.5 ATR");
  const swing = stopBounds(tech, side, entry).nearestSwing;
  if (swing !== null && dir * (swing - sl) <= 0) problems.push("stop not beyond the nearest swing");
  if (risk > 0) {
    if (Math.abs(tp1 - entry) / risk < RULES.tp1MinR - 1e-9) problems.push("TP1 below 1.5R");
    if (Math.abs(tp2 - entry) / risk < RULES.tp2MinR - 1e-9) problems.push("TP2 below 2.5R");
  }
  return problems;
}

export function validateSignal(model: ModelSignal, ctx: SignalContext): ValidatedSignal {
  const { tech, macro, calendar, now } = ctx;
  const technicalReasons = cleanList(model.technicalReasons);
  const fundamentalReasons = cleanList(model.fundamentalReasons, 4);
  const modelInvalidation = cleanText(model.invalidation, MAX_INVALIDATION_CHARS);
  const aiNewsNote = model.newsWarning ? cleanText(model.newsWarning, MAX_REASON_CHARS) : null;
  const corrections: string[] = [];
  const warnings: string[] = [];

  const reject = (reasons: string[]) =>
    noTradeSignal({ ctx, reasons, decidedBy: "ai", technicalReasons, fundamentalReasons, aiNewsNote, warnings });

  // The news gate is re-checked here so validateSignal is safe on its own.
  const blocking = blockingEvents(calendar.events, now);
  if (blocking.length > 0) {
    return reject(blocking.slice(0, 3).map((e) => `High-impact USD event within 3 hours: ${describeEvent(e, now)}.`));
  }

  if (model.bias === "NO_TRADE") {
    return noTradeSignal({
      ctx,
      reasons: ["The AI found no setup that meets the rules right now."],
      decidedBy: "ai",
      technicalReasons,
      fundamentalReasons,
      invalidation: modelInvalidation,
      aiNewsNote,
    });
  }

  const side: Side = model.bias;
  const dir = direction(side);
  const label = side === "BUY" ? "buy" : "sell";
  const { price, atr } = tech;
  const fmt = formatPrice;

  // 1. All four prices present, positive and plausibly near the market.
  const { entry: entryRaw, stopLoss: stopRaw, takeProfit1: tp1Raw, takeProfit2: tp2Raw } = model;
  if (entryRaw === null || stopRaw === null || tp1Raw === null || tp2Raw === null) {
    const missing = (
      [
        ["entry", entryRaw],
        ["stopLoss", stopRaw],
        ["takeProfit1", tp1Raw],
        ["takeProfit2", tp2Raw],
      ] as const
    )
      .filter(([, v]) => v === null)
      .map(([k]) => k);
    return reject([`The AI proposed a ${label} without usable values for: ${missing.join(", ")}.`]);
  }
  const named = { entry: entryRaw, stopLoss: stopRaw, takeProfit1: tp1Raw, takeProfit2: tp2Raw };
  const implausible = Object.entries(named)
    .filter(([, v]) => !(v > 0) || Math.abs(v - price) / price > MAX_PRICE_DEVIATION)
    .map(([k]) => k);
  if (implausible.length > 0) {
    return reject([
      `The AI levels for ${implausible.join(", ")} are more than ${MAX_PRICE_DEVIATION * 100}% from the market price of ${fmt(price)}, so they were discarded.`,
    ]);
  }

  // 2. Entry within 0.5 ATR of the current price.
  const entry = round(entryRaw, 2);
  const entryGap = Math.abs(entry - price);
  if (entryGap > RULES.entryMaxAtr * atr + HALF_CENT) {
    return reject([
      `Entry ${fmt(entry)} is ${(entryGap / atr).toFixed(2)}× ATR from the current price of ${fmt(price)}; the limit is ${RULES.entryMaxAtr}× ATR.`,
    ]);
  }
  const entryType: EntryType =
    entryGap <= Math.max(0.05 * atr, 0.01) ? "market" : dir * (entry - price) < 0 ? "limit" : "stop";

  // 3. Stop: 1 to 2.5 ATR from entry and beyond the nearest swing.
  if (dir * (entry - stopRaw) <= 0) {
    return reject([`The stop loss ${fmt(stopRaw)} is on the wrong side of the ${label} entry ${fmt(entry)}.`]);
  }
  const bounds = stopBounds(tech, side, entry);
  const swingWord = side === "BUY" ? "swing low" : "swing high";
  const minDistance = Math.ceil(bounds.minDistance * 100 - 1e-6) / 100;
  const maxDistance = Math.floor(bounds.maxDistance * 100 + 1e-6) / 100;
  if (!bounds.feasible || minDistance > maxDistance) {
    const swingText = bounds.nearestSwing !== null ? ` at ${fmt(bounds.nearestSwing)}` : "";
    return reject([
      `A stop beyond the nearest ${swingWord}${swingText} would need ${(bounds.minDistance / atr).toFixed(2)}× ATR; the maximum is ${RULES.stopMaxAtr}× ATR.`,
    ]);
  }
  let stopDistance = round(Math.abs(entry - stopRaw), 2);
  let stopCorrected = false;
  if (stopDistance < minDistance) {
    stopDistance = minDistance;
    stopCorrected = true;
    const moved = fmt(round(entry - dir * stopDistance, 2));
    corrections.push(
      bounds.bindingRule === "swing" && bounds.nearestSwing !== null
        ? `Stop moved from ${fmt(stopRaw)} to ${moved} so it sits beyond the nearest ${swingWord} at ${fmt(bounds.nearestSwing)}.`
        : `Stop moved from ${fmt(stopRaw)} to ${moved} to allow at least ${RULES.stopMinAtr}× ATR of room.`,
    );
  } else if (stopDistance > maxDistance) {
    stopDistance = maxDistance;
    stopCorrected = true;
    corrections.push(
      `Stop tightened from ${fmt(stopRaw)} to ${fmt(round(entry - dir * stopDistance, 2))}; the maximum is ${RULES.stopMaxAtr}× ATR.`,
    );
  }
  const stopLoss = round(entry - dir * stopDistance, 2);
  const risk = round(Math.abs(entry - stopLoss), 2);

  // 4. Targets: TP1 >= 1.5R, TP2 >= 2.5R and beyond TP1, both capped.
  if (dir * (tp1Raw - entry) <= 0 || dir * (tp2Raw - entry) <= 0) {
    return reject([`A take-profit is on the wrong side of the ${label} entry ${fmt(entry)}.`]);
  }
  let [first, second] = [tp1Raw, tp2Raw];
  if (Math.abs(second - entry) < Math.abs(first - entry)) {
    [first, second] = [second, first];
    corrections.push("TP1 and TP2 were swapped so TP1 is the nearer target.");
  }
  let d1 = Math.abs(first - entry);
  if (d1 < RULES.tp1MinR * risk) {
    d1 = RULES.tp1MinR * risk;
    corrections.push(`TP1 moved from ${fmt(first)} to ${fmt(roundAway(entry + dir * d1, entry))} to reach ${RULES.tp1MinR}R.`);
  } else if (d1 > RULES.tp1MaxR * risk) {
    d1 = RULES.tp1MaxR * risk;
    corrections.push(`TP1 capped at ${RULES.tp1MaxR}R (was ${fmt(first)}).`);
  }
  const takeProfit1 = roundAway(entry + dir * d1, entry);
  d1 = Math.abs(takeProfit1 - entry);

  let d2 = Math.abs(second - entry);
  const minD2 = Math.max(RULES.tp2MinR * risk, d1 + RULES.tp2GapR * risk);
  if (d2 < minD2) {
    d2 = minD2;
    corrections.push(`TP2 moved from ${fmt(second)} to ${fmt(roundAway(entry + dir * d2, entry))} to reach ${round(d2 / risk, 2)}R.`);
  } else if (d2 > RULES.tp2MaxR * risk) {
    d2 = RULES.tp2MaxR * risk;
    corrections.push(`TP2 capped at ${RULES.tp2MaxR}R (was ${fmt(second)}).`);
  }
  const takeProfit2 = roundAway(entry + dir * d2, entry);

  // 5. Obstacles between entry and TP1 (warning only).
  const obstacles = tech.timeframes
    .filter((t) => t.role !== "trigger")
    .flatMap((t) => (side === "BUY" ? t.resistances : t.supports).map((l) => ({ ...l, tf: t.timeframe })))
    .filter((l) => dir * (l.price - entry) > 0 && dir * (takeProfit1 - l.price) > 0)
    .sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry));
  if (obstacles.length > 0) {
    const o = obstacles[0];
    warnings.push(
      `${side === "BUY" ? "Resistance" : "Support"} at ${fmt(o.price)} (${o.tf}, ${o.touches} touch${o.touches === 1 ? "" : "es"}) sits before TP1.`,
    );
  }

  // 6. Confidence, adjusted for conflicts the model may have glossed over.
  const baseConfidence = model.confidence ?? 50;
  if (model.confidence === null) warnings.push("The AI gave no confidence score; 50 was assumed.");
  const penalties: Array<[number, string]> = [];
  const trendTf = tech.timeframes.find((t) => t.role === "trend");
  if (!trendTf) {
    penalties.push([10, "higher-timeframe trend unavailable"]);
  } else if (trendTf.trend === (side === "BUY" ? "down" : "up")) {
    penalties.push([15, `against the ${trendTf.timeframe} ${trendTf.trend}trend`]);
  }
  if ((side === "BUY" && macro.tilt === "bearish") || (side === "SELL" && macro.tilt === "bullish")) {
    penalties.push([10, `macro tilt is ${macro.tilt} for gold`]);
  }
  if (calendar.source === "unavailable") penalties.push([10, "economic calendar unavailable"]);
  const penalty = penalties.reduce((sum, [n]) => sum + n, 0);
  const confidence = clamp(baseConfidence - penalty, 0, 100);
  const penaltyText = penalties.map(([n, why]) => `${why} (−${n})`).join(", ");
  if (confidence < RULES.minConfidence) {
    return reject([
      penalty > 0
        ? `Confidence ${baseConfidence} drops to ${confidence} after risk checks (${penaltyText}), below the minimum of ${RULES.minConfidence}.`
        : `Confidence ${confidence} is below the minimum of ${RULES.minConfidence}.`,
    ]);
  }
  if (penalty > 0) corrections.push(`Confidence lowered from ${baseConfidence} to ${confidence}: ${penaltyText}.`);

  // 7. Invalidation: the model's narrative, anchored to the validated stop.
  const hardStop = `${side === "BUY" ? "A move below" : "A move above"} ${fmt(stopLoss)} hits the stop and invalidates the idea.`;
  const invalidation = !modelInvalidation
    ? hardStop
    : stopCorrected
      ? `${modelInvalidation} The hard stop was adjusted to ${fmt(stopLoss)} by the risk checks.`
      : modelInvalidation;

  const signal: ValidatedSignal = {
    bias: side,
    confidence,
    entry,
    entryType,
    stopLoss,
    takeProfit1,
    takeProfit2,
    riskReward1: round(Math.abs(takeProfit1 - entry) / risk, 2),
    riskReward2: round(Math.abs(takeProfit2 - entry) / risk, 2),
    riskUsd: risk,
    stopAtr: round(risk / atr, 2),
    technicalReasons: technicalReasons.length > 0 ? technicalReasons : technicalFacts(tech),
    fundamentalReasons: fundamentalReasons.length > 0 ? fundamentalReasons : fundamentalFacts(macro, calendar, now),
    invalidation,
    newsWarning: newsWarningText(calendar, now),
    aiNewsNote,
    noTradeReasons: [],
    corrections,
    warnings,
    decidedBy: "ai",
  };

  const problems = checkInvariants(signal, tech);
  if (problems.length > 0) {
    return reject([`The corrected levels still failed the final risk check (${problems.join(", ")}).`]);
  }
  return signal;
}
