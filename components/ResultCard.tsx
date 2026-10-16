import { MODE_TIMEFRAMES } from "@/lib/config";
import { formatPrice } from "@/lib/num";
import { formatUtc } from "@/lib/time";
import type { Bias, SignalResponse, ValidatedSignal } from "@/lib/types";
import LevelLadder from "./LevelLadder";
import SnapshotDetails from "./SnapshotDetails";

const BIAS_TEXT: Record<Bias, string> = { BUY: "BUY", SELL: "SELL", NO_TRADE: "NO TRADE" };
const BIAS_STYLE: Record<Bias, string> = {
  BUY: "bg-buy text-ink",
  SELL: "bg-sell text-ink",
  NO_TRADE: "border border-paper/40 text-paper",
};

function entryTypeLabel(s: ValidatedSignal): string {
  if (s.entryType === "market" || s.entryType === null) return "Market order";
  return `${s.bias === "BUY" ? "Buy" : "Sell"} ${s.entryType}`;
}

function usd(value: number): string {
  return `$${formatPrice(value)}`;
}

interface LevelProps {
  label: string;
  value: number;
  detail: string;
  tone: "neutral" | "risk" | "reward";
}

function Level({ label, value, detail, tone }: LevelProps) {
  const toneClass = tone === "risk" ? "text-sell" : tone === "reward" ? "text-buy" : "text-paper";
  return (
    <div className="rounded-md bg-ink/60 px-3 py-3">
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd className={`num mt-0.5 text-[1.375rem] font-semibold leading-tight sm:text-2xl ${toneClass}`}>{formatPrice(value)}</dd>
      <dd className="num mt-0.5 text-[12px] text-muted">{detail}</dd>
    </div>
  );
}

function Bullets({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="rounded-md border border-line p-4">
      <h3 className="text-sm font-semibold text-paper">{title}</h3>
      <ul className="mt-2 space-y-2 text-[15px] leading-snug text-paper/90">
        {items.map((text, i) => (
          <li
            key={`${i}-${text.slice(0, 24)}`}
            className="relative pl-4 before:absolute before:left-0 before:top-[0.55em] before:size-1.5 before:rounded-full before:bg-gold"
          >
            {text}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Confidence({ value }: { value: number }) {
  return (
    <div className="w-36">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] text-muted">Confidence</span>
        <span className="num text-xl font-semibold text-paper">{value}</span>
      </div>
      <div
        className="mt-1 h-1.5 rounded-full bg-line"
        role="meter"
        aria-label="Confidence"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
      >
        <div className="h-full rounded-full bg-gold" style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

export default function ResultCard({ data, dimmed }: { data: SignalResponse; dimmed: boolean }) {
  const { signal: s, snapshot, meta } = data;
  const levels =
    s.bias !== "NO_TRADE" &&
    s.entry !== null &&
    s.stopLoss !== null &&
    s.takeProfit1 !== null &&
    s.takeProfit2 !== null &&
    s.riskReward1 !== null &&
    s.riskReward2 !== null &&
    s.riskUsd !== null
      ? {
          entry: s.entry,
          stopLoss: s.stopLoss,
          takeProfit1: s.takeProfit1,
          takeProfit2: s.takeProfit2,
          riskReward1: s.riskReward1,
          riskReward2: s.riskReward2,
          riskUsd: s.riskUsd,
        }
      : null;
  const modeLabel = snapshot.mode === "day" ? "Day" : "Swing";

  return (
    <article
      className={`space-y-4 rounded-[10px] border border-line bg-panel p-4 transition-opacity sm:p-5 ${dimmed ? "opacity-50" : ""}`}
      aria-label="Analysis result"
    >
      {s.newsWarning && (
        <div role="status" className="rounded-md bg-amber px-4 py-3 text-ink">
          <p className="flex gap-2.5 text-[15px] font-medium leading-snug">
            <svg viewBox="0 0 20 20" className="mt-0.5 size-4 shrink-0" fill="currentColor" aria-hidden="true">
              <path d="M10 1.5 19 18H1L10 1.5Zm-1 6v5h2v-5H9Zm0 6.5v2h2v-2H9Z" />
            </svg>
            <span>{s.newsWarning}</span>
          </p>
          {s.aiNewsNote && <p className="mt-1.5 pl-6.5 text-[13px] text-ink/80">Model note: {s.aiNewsNote}</p>}
        </div>
      )}

      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className={`hallmark rounded px-3 py-1.5 text-2xl font-extrabold leading-none ${BIAS_STYLE[s.bias]}`}>
            {BIAS_TEXT[s.bias]}
          </span>
          <p className="text-[13px] leading-snug text-muted">
            <span className="text-paper">{modeLabel}</span> {MODE_TIMEFRAMES[snapshot.mode].join(" / ")}
            <br />
            <time dateTime={snapshot.generatedAt}>{formatUtc(Date.parse(snapshot.generatedAt))}</time>
          </p>
        </div>
        {s.confidence !== null && s.bias !== "NO_TRADE" && <Confidence value={s.confidence} />}
      </header>

      {s.bias === "NO_TRADE" && s.noTradeReasons.length > 0 && (
        <section className="rounded-md border border-paper/20 bg-ink/50 p-4">
          <h3 className="text-sm font-semibold text-paper">Why there is no trade</h3>
          <ul className="mt-2 space-y-1.5 text-[15px] leading-snug text-paper/90">
            {s.noTradeReasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </section>
      )}

      {levels && (
        <section aria-label="Trade levels">
          <dl className="grid grid-cols-2 gap-2">
            <Level label="Entry" value={levels.entry} detail={entryTypeLabel(s)} tone="neutral" />
            <Level
              label="Stop loss"
              value={levels.stopLoss}
              detail={`−${usd(levels.riskUsd)}, ${s.stopAtr}× ATR`}
              tone="risk"
            />
            <Level
              label="TP1"
              value={levels.takeProfit1}
              detail={`+${usd(Math.abs(levels.takeProfit1 - levels.entry))}, ${levels.riskReward1}R`}
              tone="reward"
            />
            <Level
              label="TP2"
              value={levels.takeProfit2}
              detail={`+${usd(Math.abs(levels.takeProfit2 - levels.entry))}, ${levels.riskReward2}R`}
              tone="reward"
            />
          </dl>
          <p className="num mt-3 text-[15px] text-paper">
            Risk:reward <span className="font-semibold">1:{levels.riskReward1}</span> to TP1 and{" "}
            <span className="font-semibold">1:{levels.riskReward2}</span> to TP2
          </p>
          <LevelLadder riskReward1={levels.riskReward1} riskReward2={levels.riskReward2} />
        </section>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <Bullets title="Technicals" items={s.technicalReasons} />
        <Bullets title="Fundamentals" items={s.fundamentalReasons} />
      </div>

      <section className="border-l-2 border-gold pl-3">
        <h3 className="text-sm font-semibold text-paper">Invalidation</h3>
        <p className="mt-1 text-[15px] leading-snug text-paper/90">{s.invalidation}</p>
      </section>

      {(s.corrections.length > 0 || s.warnings.length > 0) && (
        <section className="rounded-md bg-ink/50 p-4">
          <h3 className="text-sm font-semibold text-paper">Risk checks</h3>
          <ul className="mt-2 space-y-1.5 text-[14px] leading-snug">
            {s.corrections.map((c) => (
              <li key={c} className="text-paper/90">
                <span className="text-gold">Adjusted:</span> {c}
              </li>
            ))}
            {s.warnings.map((w) => (
              <li key={w} className="text-muted">
                <span className="text-amber">Note:</span> {w}
              </li>
            ))}
          </ul>
        </section>
      )}

      <SnapshotDetails snapshot={snapshot} />

      <p className="text-[12px] leading-snug text-muted">
        {s.decidedBy === "rules"
          ? "Decided by the rule checks without consulting the AI."
          : `Levels are computed and checked in code; reasons written by ${meta.model}.`}{" "}
        Price {formatPrice(snapshot.price)} from the {snapshot.priceTimeframe} candle opened {formatUtc(Date.parse(snapshot.priceTime))}, ATR{" "}
        {formatPrice(snapshot.atr)} ({snapshot.setupTimeframe}). Took {(meta.durationMs / 1000).toFixed(1)}s.
      </p>
    </article>
  );
}
