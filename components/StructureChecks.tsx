"use client";

import type { SignalResponse } from "@/lib/types";

type DotTone = "agree" | "neutral" | "against";

function Dot({ tone }: { tone: DotTone }) {
  const cls = tone === "agree" ? "bg-buy" : tone === "against" ? "bg-sell" : "bg-muted";
  return <span aria-hidden className={`inline-block size-2.5 rounded-full ${cls}`} />;
}

interface CheckRow {
  text: string;
  tone: DotTone;
}

function buildRows(data: SignalResponse): CheckRow[] {
  const snap = data.snapshot.structure as Record<string, unknown> | null | undefined;
  const signal = data.signal;
  if (!snap || typeof snap !== "object") return [];
  const rows: CheckRow[] = [];
  const side = signal.bias as string;
  // Type cast the snapshot; it comes from smcToAiBlock
  const s = snap as {
    dealingRange?: { pricePositionPct: number; zone: string } | null;
    bos?: { direction: string; candlesAgo: number } | null;
    choch?: { direction: string; candlesAgo: number } | null;
    sweep?: { direction: string; candlesAgo: number } | null;
    fvgs?: { bullish?: { top: number; bottom: number } | null; bearish?: { top: number; bottom: number } | null };
    sma?: { priceVsSma50: string; priceVsSma200: string; cross: string | null; crossCandlesAgo: number | null };
  };

  // 1. Zone
  if (s.dealingRange) {
    const pct = s.dealingRange.pricePositionPct;
    const zone = s.dealingRange.zone;
    if (zone === "discount") {
      const tone: DotTone = side === "SELL" ? "against" : side === "BUY" ? "agree" : "neutral";
      const text = side === "SELL"
        ? `Price is low in its recent range (${pct.toFixed(0)}%), so selling here is riskier.`
        : side === "BUY"
          ? `Price is low in its recent range (${pct.toFixed(0)}%) — better location for buying.`
          : `Price is low in its recent range (${pct.toFixed(0)}%) (discount zone).`;
      rows.push({ text, tone });
    } else if (zone === "premium") {
      const tone: DotTone = side === "BUY" ? "against" : side === "SELL" ? "agree" : "neutral";
      const text = side === "BUY"
        ? `Price is high in its recent range (${pct.toFixed(0)}%), so buying here is riskier.`
        : side === "SELL"
          ? `Price is high in its recent range (${pct.toFixed(0)}%) — better location for selling.`
          : `Price is high in its recent range (${pct.toFixed(0)}%) (premium zone).`;
      rows.push({ text, tone });
    } else {
      rows.push({ text: `Price is mid-range (${pct.toFixed(0)}%) — no zone edge.`, tone: "neutral" });
    }
  }

  // 2. CHoCH / BOS
  if (s.choch) {
    const dir = s.choch.direction;
    const ago = s.choch.candlesAgo;
    const bullish = dir === "bullish";
    const tone: DotTone = side === "BUY" && bullish ? "agree" : side === "SELL" && !bullish ? "agree" : side !== "NO_TRADE" ? "against" : "neutral";
    // Use spec's example wording style
    const text = bullish
      ? `Bullish change of character ${ago} candles ago: the downtrend may be turning.`
      : `Bearish change of character ${ago} candles ago: the uptrend may be turning.`;
    rows.push({ text, tone });
  } else if (s.bos) {
    const dir = s.bos.direction;
    const ago = s.bos.candlesAgo;
    const text = dir === "bullish"
      ? `Bullish break of structure ${ago} candles ago — trend continuation.`
      : `Bearish break of structure ${ago} candles ago — trend continuation.`;
    const tone: DotTone = (side === "BUY" && dir === "bullish") || (side === "SELL" && dir === "bearish") ? "agree" : side !== "NO_TRADE" ? "neutral" : "neutral";
    rows.push({ text, tone });
  } else {
    rows.push({ text: "No recent break of structure or change of character.", tone: "neutral" });
  }

  // 3. Sweep
  if (s.sweep) {
    const tone: DotTone = (side === "BUY" && s.sweep.direction === "lows") || (side === "SELL" && s.sweep.direction === "highs") ? "agree" : "against";
    const which = s.sweep.direction === "highs" ? "highs" : "lows";
    rows.push({ text: `Liquidity sweep of ${which} ${s.sweep.candlesAgo} candles ago.`, tone });
  } else {
    rows.push({ text: "No recent liquidity sweep.", tone: "neutral" });
  }

  // 4. FVG obstacle vs side
  const entry = signal.entry;
  const tp1 = signal.takeProfit1;
  if (entry !== null && tp1 !== null && s.fvgs) {
    let obstacle: string | null = null;
    let tone: DotTone = "neutral";
    if (side === "BUY" && s.fvgs.bearish) {
      const f = s.fvgs.bearish;
      const low = Math.min(entry, tp1);
      const high = Math.max(entry, tp1);
      if (f.bottom < high && f.top > low) {
        obstacle = "Bearish fair value gap between entry and TP1 may act as resistance.";
        tone = "against";
      }
    } else if (side === "SELL" && s.fvgs.bullish) {
      const f = s.fvgs.bullish;
      const low = Math.min(entry, tp1);
      const high = Math.max(entry, tp1);
      if (f.bottom < high && f.top > low) {
        obstacle = "Bullish fair value gap between entry and TP1 may act as support.";
        tone = "against";
      }
    }
    if (obstacle) rows.push({ text: obstacle, tone });
    else {
      const hasBull = !!s.fvgs.bullish;
      const hasBear = !!s.fvgs.bearish;
      if (hasBull || hasBear) rows.push({ text: "No unfilled fair value gap blocking the path to TP1.", tone: "agree" });
      else rows.push({ text: "No unfilled fair value gaps nearby.", tone: "neutral" });
    }
  } else {
    if (s.fvgs?.bullish || s.fvgs?.bearish) rows.push({ text: "Fair value gaps present nearby.", tone: "neutral" });
    else rows.push({ text: "No unfilled fair value gaps nearby.", tone: "neutral" });
  }

  // 5. SMA context
  if (s.sma) {
    const vs200 = s.sma.priceVsSma200;
    if (vs200 !== "unavailable") {
      const tone: DotTone = (side === "BUY" && vs200 === "above") || (side === "SELL" && vs200 === "below") ? "agree" : (side !== "NO_TRADE" ? "against" : "neutral");
      const text = vs200 === "above" ? "Price is above SMA200 on the trend timeframe." : "Price is below SMA200 on the trend timeframe.";
      rows.push({ text, tone });
      if (s.sma.cross) {
        const crossTone: DotTone = (s.sma.cross === "golden" && side === "BUY") || (s.sma.cross === "death" && side === "SELL") ? "agree" : "neutral";
        const crossText = s.sma.cross === "golden" ? `Golden cross ${s.sma.crossCandlesAgo ?? "?"} candles ago.` : `Death cross ${s.sma.crossCandlesAgo ?? "?"} candles ago.`;
        rows.push({ text: crossText, tone: crossTone });
      }
    } else {
      rows.push({ text: "SMA200 unavailable on the trend timeframe.", tone: "neutral" });
    }
  }

  return rows;
}

export default function StructureChecks({ data }: { data: SignalResponse }) {
  const snap = data.snapshot.structure;
  // Hide if SMC unavailable/disabled, or no structure block
  if (!snap || typeof snap !== "object" || (snap as Record<string, unknown>).zone === undefined) {
    // Also check disabled/availability via signal verdict
    const v = (data.signal as unknown as { smcVerdict?: string }).smcVerdict;
    if (v === "unavailable" || v === undefined) return null;
    // If structure is null but verdict is available? hide
    if (snap === null) return null;
  }
  if (snap === null) return null;
  const rows = buildRows(data);
  if (rows.length === 0) return null;
  return (
    <section aria-label="Structure checks" className="rounded-md border border-line bg-ink/40 p-4">
      <h3 className="text-sm font-semibold text-paper">Structure checks</h3>
      <ul className="mt-2 space-y-2">
        {rows.map((r, i) => (
          <li key={i} className="flex items-start gap-2 text-[14px] leading-snug text-paper/90">
            <span className="mt-1 shrink-0"><Dot tone={r.tone} /></span>
            <span>{r.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
