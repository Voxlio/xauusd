/** Deterministic technical bullet points, used when the AI is skipped or returns no reasons. */
import { formatPrice } from "../num";
import type { TechnicalSummary, TimeframeSnapshot } from "../types";

const TREND_WORD: Record<TimeframeSnapshot["trend"], string> = {
  up: "uptrend",
  down: "downtrend",
  range: "range",
};

function emaPosition(tf: TimeframeSnapshot): string | null {
  const emas: Array<[string, number | null]> = [
    ["EMA20", tf.ema20],
    ["EMA50", tf.ema50],
    ["EMA200", tf.ema200],
  ];
  const known = emas.filter((e): e is [string, number] => e[1] !== null);
  if (known.length === 0) return null;
  const above = known.filter(([, v]) => tf.close > v).map(([n]) => n);
  const below = known.filter(([, v]) => tf.close < v).map(([n]) => n);
  if (below.length === 0) return `above ${above.join("/")}`;
  if (above.length === 0) return `below ${below.join("/")}`;
  return `above ${above.join("/")}, below ${below.join("/")}`;
}

function macdWord(tf: TimeframeSnapshot): string | null {
  if (!tf.macd) return null;
  const side = tf.macd.histogram >= 0 ? "positive" : "negative";
  const slope = tf.macd.histogram > tf.macd.histogramPrev ? "rising" : tf.macd.histogram < tf.macd.histogramPrev ? "falling" : "flat";
  return `MACD histogram ${side} and ${slope}`;
}

export function technicalFacts(tech: TechnicalSummary): string[] {
  const facts = tech.timeframes.map((tf) => {
    const parts = [
      `${TREND_WORD[tf.trend]} (score ${tf.trendScore})`,
      emaPosition(tf),
      tf.rsi14 !== null ? `RSI ${tf.rsi14.toFixed(1)}` : null,
      macdWord(tf),
    ].filter(Boolean);
    return `${tf.timeframe}: ${parts.join(", ")}.`;
  });
  const setup = tech.timeframes.find((t) => t.role === "setup");
  if (setup) {
    const s = setup.supports[0];
    const r = setup.resistances[0];
    const levels = [
      s ? `support ${formatPrice(s.price)}` : null,
      r ? `resistance ${formatPrice(r.price)}` : null,
    ].filter(Boolean);
    facts.push(
      `${setup.timeframe} ATR(14) ${formatPrice(tech.atr)}${levels.length ? `; nearest ${levels.join(", ")}` : ""}.`,
    );
  }
  return facts;
}
