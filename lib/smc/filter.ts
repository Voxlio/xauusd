import { RULES } from "../config";
import type { ValidatedSignal } from "../types";
import { fvgBetween } from "./fvg";
import type { SmcSnapshot } from "./index";
import { getSmcPenalties, getSmcThresholds } from "./config";

export type SmcVerdict = "agree" | "neutral" | "against" | "unavailable";

export interface SmcPenaltyDetail {
  code: "zone" | "choch" | "sweep" | "fvg" | "sma";
  penalty: number;
  message: string;
}

export interface SmcFilterResult {
  signal: ValidatedSignal;
  verdict: SmcVerdict;
  penalties: SmcPenaltyDetail[];
  appliedPenaltiesTotal: number;
  hardBlocked: boolean;
}

/**
 * Apply SMC confidence penalties AFTER existing validation. Never creates a trade.
 * Only lowers confidence or turns weak setup into NO_TRADE via existing <40 rule, or via hard block.
 */
export function applySmcFilter(
  signal: ValidatedSignal,
  snapshot: SmcSnapshot,
  thresholds = getSmcThresholds(),
  penaltiesCfg = getSmcPenalties(),
): SmcFilterResult {
  // SMC disabled: leave signal exactly unchanged, verdict unavailable
  if (penaltiesCfg.enabled === false || snapshot.disabled) {
    return {
      signal: { ...signal, smcVerdict: "unavailable" as const, smcPenalties: [] as SmcPenaltyDetail[] } as unknown as ValidatedSignal,
      verdict: "unavailable",
      penalties: [],
      appliedPenaltiesTotal: 0,
      hardBlocked: false,
    };
  }
  if (!snapshot.available || signal.bias === "NO_TRADE" || signal.confidence === null || signal.entry === null || signal.takeProfit1 === null) {
    const v: SmcVerdict = !snapshot.available ? "unavailable" : "neutral";
    // Do not mutate NO_TRADE signals
    const patched = signal.bias === "NO_TRADE"
      ? ({ ...signal, smcVerdict: v, smcPenalties: [] } as unknown as ValidatedSignal)
      : ({ ...signal, smcVerdict: v, smcPenalties: [] } as unknown as ValidatedSignal);
    return { signal: patched, verdict: v, penalties: [], appliedPenaltiesTotal: 0, hardBlocked: false };
  }

  const side = signal.bias as "BUY" | "SELL";
  const pct = snapshot.pricePositionPct;
  const zone = snapshot.zone;
  const choch = snapshot.structure.choch;
  const sweep = snapshot.sweep;
  const fvgs = snapshot.fvgs;
  const sma = snapshot.sma;

  const details: SmcPenaltyDetail[] = [];

  // 1. Zone: selling in discount or buying in premium
  const zoneAgainst = (side === "SELL" && zone === "discount") || (side === "BUY" && zone === "premium");
  if (zoneAgainst) {
    const msg =
      side === "SELL"
        ? `Price is low in its recent range (${pct !== null ? pct.toFixed(0) : "?" }%), so selling here is riskier.`
        : `Price is high in its recent range (${pct !== null ? pct.toFixed(0) : "?" }%), so buying here is riskier.`;
    details.push({ code: "zone", penalty: penaltiesCfg.penZone, message: msg + ` (−${penaltiesCfg.penZone})` });
  }

  // 2. Opposite CHoCH within lookback
  const oppositeChoch = choch && (
    (side === "BUY" && choch.direction === "bearish") ||
    (side === "SELL" && choch.direction === "bullish")
  ) && choch.candlesAgo <= thresholds.chochLookback;
  if (oppositeChoch) {
    const dirWord = choch!.direction === "bullish" ? "Bullish" : "Bearish";
    details.push({
      code: "choch",
      penalty: penaltiesCfg.penChoch,
      message: `${dirWord} change of character ${choch!.candlesAgo} candles ago: the trend may be turning. (−${penaltiesCfg.penChoch})`,
    });
  }

  // 3. Sweep that favors opposite side within last 6
  const sweepAgainst = sweep && (
    (side === "BUY" && sweep.direction === "highs") ||
    (side === "SELL" && sweep.direction === "lows")
  );
  if (sweepAgainst) {
    const which = sweep!.direction === "highs" ? "highs" : "lows";
    details.push({
      code: "sweep",
      penalty: penaltiesCfg.penSweep,
      message: `Recent liquidity sweep of ${which} ${sweep!.candlesAgo} candles ago favors the opposite side. (−${penaltiesCfg.penSweep})`,
    });
  }

  // 4. Unfilled FVG between entry and TP1
  const entry = signal.entry as number;
  const tp1 = signal.takeProfit1 as number;
  let fvgObstacle: boolean = false;
  let fvgMsg: string | null = null;
  if (side === "BUY" && fvgs.bearish && fvgBetween(fvgs.bearish, entry, tp1)) {
    fvgObstacle = true;
    fvgMsg = `Bearish fair value gap between entry and TP1 may act as resistance. (−${penaltiesCfg.penFvg})`;
  } else if (side === "SELL" && fvgs.bullish && fvgBetween(fvgs.bullish, entry, tp1)) {
    fvgObstacle = true;
    fvgMsg = `Bullish fair value gap between entry and TP1 may act as support. (−${penaltiesCfg.penFvg})`;
  }
  if (fvgObstacle && fvgMsg) details.push({ code: "fvg", penalty: penaltiesCfg.penFvg, message: fvgMsg });

  // 5. Price on wrong side of SMA200
  const smaWrong = (side === "BUY" && sma.priceVsSma200 === "below") || (side === "SELL" && sma.priceVsSma200 === "above");
  if (smaWrong && sma.priceVsSma200 !== "unavailable") {
    details.push({
      code: "sma",
      penalty: penaltiesCfg.penSma,
      message: `Price is on the wrong side of SMA200 on the trend timeframe. (−${penaltiesCfg.penSma})`,
    });
  }

  // Hard block check before applying penalties
  if (penaltiesCfg.hardBlock && zoneAgainst && oppositeChoch) {
    const deep = side === "SELL"
      ? pct !== null && pct <= thresholds.hardBlockZone
      : pct !== null && pct >= 100 - thresholds.hardBlockZone;
    if (deep) {
      const reason = side === "SELL"
        ? `Selling deep in discount (${pct!.toFixed(0)}%) with a bullish change of character nearby is blocked by structure checks.`
        : `Buying deep in premium (${pct!.toFixed(0)}%) with a bearish change of character nearby is blocked by structure checks.`;
      const blocked: ValidatedSignal = {
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
        technicalReasons: signal.technicalReasons,
        fundamentalReasons: signal.fundamentalReasons,
        invalidation: reason,
        newsWarning: signal.newsWarning,
        aiNewsNote: signal.aiNewsNote,
        noTradeReasons: [reason],
        corrections: [...signal.corrections],
        warnings: [...signal.warnings, ...details.map((d) => d.message)],
        decidedBy: signal.decidedBy,
        smcVerdict: "against",
        smcPenalties: details,
      } as unknown as ValidatedSignal;
      return { signal: blocked, verdict: "against", penalties: details, appliedPenaltiesTotal: details.reduce((s, d) => s + d.penalty, 0), hardBlocked: true };
    }
  }

  const total = details.reduce((s, d) => s + d.penalty, 0);
  const base = signal.confidence as number;
  const adjusted = Math.max(0, Math.min(100, base - total));

  // Below 40 => NO_TRADE per existing rule
  if (adjusted < RULES.minConfidence) {
    const reason = `Confidence ${base} drops to ${adjusted} after structure checks (${details.map((d) => d.message).join("; ")}), below the minimum of ${RULES.minConfidence}.`;
    const blocked: ValidatedSignal = {
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
      technicalReasons: signal.technicalReasons,
      fundamentalReasons: signal.fundamentalReasons,
      invalidation: reason,
      newsWarning: signal.newsWarning,
      aiNewsNote: signal.aiNewsNote,
      noTradeReasons: [reason],
      corrections: [...signal.corrections],
      warnings: [...signal.warnings, ...details.map((d) => d.message)],
      decidedBy: signal.decidedBy,
      smcVerdict: "against",
      smcPenalties: details,
    } as unknown as ValidatedSignal;
    return { signal: blocked, verdict: "against", penalties: details, appliedPenaltiesTotal: total, hardBlocked: false };
  }

  // Otherwise lower confidence and record penalties in corrections/warnings (plain English)
  const corrections = [...signal.corrections];
  const warnings = [...signal.warnings];
  if (total > 0) {
    const penaltyText = details.map((d) => d.message.replace(/\s*\(−\d+\)\s*$/, "") + ` (−${d.penalty})`).join(", ");
    corrections.push(`Confidence lowered from ${base} to ${adjusted}: ${penaltyText}.`);
    // Also push each detail as warning for visibility? Spec says record every applied penalty in existing corrections/warnings list in plain English. We'll put summary in corrections and details in warnings.
    for (const d of details) warnings.push(d.message);
  }

  // Determine verdict: against if any penalty, else agree/neutral based on alignment
  let verdict: SmcVerdict = "neutral";
  if (details.length > 0) verdict = "against";
  else {
    // No penalties: check if any agrees
    const anyAgree = (() => {
      if ((side === "BUY" && zone === "discount") || (side === "SELL" && zone === "premium")) return true;
      if (choch && ((side === "BUY" && choch.direction === "bullish") || (side === "SELL" && choch.direction === "bearish")) && choch.candlesAgo <= thresholds.chochLookback) return true;
      if (sweep && ((side === "BUY" && sweep.direction === "lows") || (side === "SELL" && sweep.direction === "highs"))) return true;
      if ((side === "BUY" && sma.priceVsSma200 === "above") || (side === "SELL" && sma.priceVsSma200 === "below")) return true;
      return false;
    })();
    verdict = anyAgree ? "agree" : "neutral";
  }

  const patched: ValidatedSignal = {
    ...signal,
    confidence: details.length > 0 ? adjusted : signal.confidence,
    corrections,
    warnings,
    smcVerdict: verdict,
    smcPenalties: details,
  } as unknown as ValidatedSignal;

  return { signal: patched, verdict, penalties: details, appliedPenaltiesTotal: total, hardBlocked: false };
}
