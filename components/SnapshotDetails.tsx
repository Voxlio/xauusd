import { formatPrice } from "@/lib/num";
import { formatUtc } from "@/lib/time";
import type { DataStatusItem, SignalSnapshot, TimeframeSnapshot } from "@/lib/types";

const TREND_LABEL: Record<TimeframeSnapshot["trend"], string> = { up: "Up", down: "Down", range: "Range" };
const TREND_TONE: Record<TimeframeSnapshot["trend"], string> = { up: "text-buy", down: "text-sell", range: "text-paper" };

function price(v: number | null): string {
  return v === null ? "n/a" : formatPrice(v);
}

function dataState(d: DataStatusItem): string {
  if (d.state === "fresh") return "live";
  if (d.state === "cache") return `cached ${d.ageSeconds ?? 0}s`;
  if (d.state === "stale") return `stale copy, ${d.ageSeconds ?? 0}s old`;
  return "unavailable";
}

export default function SnapshotDetails({ snapshot }: { snapshot: SignalSnapshot }) {
  const { timeframes, macro, calendar, dataStatus } = snapshot;
  return (
    <details className="group rounded-md border border-line">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-paper [&::-webkit-details-marker]:hidden">
        Indicator snapshot
        <span className="text-muted transition-transform group-open:rotate-180" aria-hidden="true">
          ▾
        </span>
      </summary>

      <div className="space-y-5 border-t border-line px-4 pb-4 pt-3">
        <div className="-mx-4 overflow-x-auto px-4">
          <table className="num w-full min-w-[34rem] text-left text-[13px]">
            <caption className="sr-only">Indicators per timeframe</caption>
            <thead className="text-muted">
              <tr>
                <th scope="col" className="py-1.5 pr-3 font-medium">TF</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">Trend</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">Close</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">EMA 20 / 50 / 200</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">RSI 14</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">MACD hist.</th>
                <th scope="col" className="py-1.5 font-medium">ATR 14</th>
              </tr>
            </thead>
            <tbody>
              {timeframes.map((t) => (
                <tr key={t.timeframe} className="border-t border-line/70 align-top">
                  <th scope="row" className="py-2 pr-3 font-semibold text-paper">
                    {t.timeframe}
                    <span className="block text-[11px] font-normal text-muted">{t.role}</span>
                  </th>
                  <td className={`py-2 pr-3 ${TREND_TONE[t.trend]}`}>
                    {TREND_LABEL[t.trend]}
                    <span className="block text-[11px] text-muted">score {t.trendScore}</span>
                  </td>
                  <td className="py-2 pr-3">{formatPrice(t.close)}</td>
                  <td className="py-2 pr-3">
                    {price(t.ema20)} / {price(t.ema50)} / {price(t.ema200)}
                  </td>
                  <td className="py-2 pr-3">{t.rsi14 === null ? "n/a" : t.rsi14.toFixed(1)}</td>
                  <td className="py-2 pr-3">
                    {t.macd ? (
                      <>
                        {t.macd.histogram.toFixed(2)}
                        <span className="block text-[11px] text-muted">
                          {t.macd.histogram > t.macd.histogramPrev ? "rising" : t.macd.histogram < t.macd.histogramPrev ? "falling" : "flat"}
                        </span>
                      </>
                    ) : (
                      "n/a"
                    )}
                  </td>
                  <td className="py-2">{price(t.atr14)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <section>
            <h4 className="text-[13px] font-semibold text-paper">Levels</h4>
            <ul className="num mt-1 space-y-1 text-[13px] text-muted">
              {timeframes.map((t) => (
                <li key={t.timeframe}>
                  <span className="text-paper">{t.timeframe}</span> support{" "}
                  {t.supports.length ? t.supports.map((l) => formatPrice(l.price)).join(", ") : "none"}; resistance{" "}
                  {t.resistances.length ? t.resistances.map((l) => formatPrice(l.price)).join(", ") : "none"}
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h4 className="text-[13px] font-semibold text-paper">Macro ({macro.tilt} for gold)</h4>
            <ul className="mt-1 space-y-1 text-[13px] text-muted">
              {macro.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </section>
          <section>
            <h4 className="text-[13px] font-semibold text-paper">High-impact USD events, next 48h</h4>
            {calendar.events.length === 0 ? (
              <p className="mt-1 text-[13px] text-muted">
                {calendar.source === "unavailable" ? "Calendar unavailable." : "None scheduled."}
              </p>
            ) : (
              <ul className="mt-1 space-y-1 text-[13px] text-muted">
                {calendar.events.map((e) => (
                  <li key={`${e.time}-${e.title}`}>
                    <span className="text-paper">{e.title}</span> {formatUtc(e.time)}
                    {e.forecast ? `, forecast ${e.forecast}` : ""}
                    {e.previous ? `, previous ${e.previous}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h4 className="text-[13px] font-semibold text-paper">Data sources</h4>
            <ul className="mt-1 space-y-1 text-[13px] text-muted">
              {dataStatus.map((d) => (
                <li key={d.name}>
                  <span className={d.state === "missing" ? "text-sell" : d.state === "stale" ? "text-amber" : "text-paper"}>
                    {d.name}
                  </span>{" "}
                  {dataState(d)}
                  {d.detail && d.state !== "fresh" && d.state !== "cache" ? `: ${d.detail}` : ""}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </details>
  );
}
