"use client";

import { useState, useSyncExternalStore } from "react";
import {
  historyStats,
  realizedR,
  removeEntry,
  RESULT_LABEL,
  RESULTS,
  setResult,
  tp1R,
  type HistoryEntry,
  type TradeResult,
} from "@/lib/history";
import { getHistorySnapshot, getServerHistorySnapshot, isMemoryOnly, subscribeHistory, updateHistory } from "@/lib/historyStore";
import { formatPrice } from "@/lib/num";
import type { SmcVerdict } from "@/lib/types";

const RESULT_ACTIVE: Record<TradeResult, string> = {
  open: "bg-raised text-paper",
  tp: "bg-buy text-ink",
  sl: "bg-sell text-ink",
  skipped: "bg-paper/20 text-paper",
};

const VERDICT_LABEL: Record<SmcVerdict, string> = {
  agree: "Agree",
  neutral: "Neutral",
  against: "Against",
  unavailable: "n/a",
};
const VERDICT_TONE: Record<SmcVerdict, string> = {
  agree: "text-buy",
  neutral: "text-muted",
  against: "text-sell",
  unavailable: "text-muted",
};

function signedR(r: number): string {
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r).toFixed(2)}R`;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-md bg-ink/60 px-3 py-2.5">
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd className="num text-xl font-semibold text-paper">{value}</dd>
      {detail && <dd className="num text-[11px] text-muted">{detail}</dd>}
    </div>
  );
}

function HistoryRow({ entry }: { entry: HistoryEntry }) {
  const r = realizedR(entry);
  const label = `${entry.bias} signal from ${when(entry.createdAt)}`;
  const verdict = (entry.smcVerdict ?? "unavailable") as SmcVerdict;
  return (
    <li className="py-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className={`hallmark text-sm font-extrabold ${entry.bias === "BUY" ? "text-buy" : "text-sell"}`}>{entry.bias}</span>
        <span className="text-[12px] text-muted">
          <time dateTime={entry.createdAt}>{when(entry.createdAt)}</time>, {entry.mode === "day" ? "Day" : "Swing"}
        </span>
      </div>
      <dl className="num mt-1.5 grid grid-cols-3 gap-2 text-[13px]">
        <div>
          <dt className="text-[11px] text-muted">Entry</dt>
          <dd className="text-paper">{formatPrice(entry.entry)}</dd>
        </div>
        <div>
          <dt className="text-[11px] text-muted">SL</dt>
          <dd className="text-paper">{formatPrice(entry.stopLoss)}</dd>
        </div>
        <div>
          <dt className="text-[11px] text-muted">TP ({tp1R(entry).toFixed(1)}R)</dt>
          <dd className="text-paper">{formatPrice(entry.takeProfit1)}</dd>
        </div>
      </dl>
      <div className="mt-1.5 flex items-center gap-2 text-[11px]">
        <span className={VERDICT_TONE[verdict]}>SMC: {VERDICT_LABEL[verdict]}</span>
        {entry.smcPenalties && entry.smcPenalties.length > 0 && (
          <span className="text-muted">({entry.smcPenalties.map((p) => `−${p.penalty}`).join(", ")})</span>
        )}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <div role="group" aria-label={`Result for ${label}`} className="flex flex-1 gap-1 rounded-md bg-ink/60 p-0.5">
          {RESULTS.map((res) => (
            <button
              key={res}
              type="button"
              aria-pressed={entry.result === res}
              onClick={() => updateHistory((list) => setResult(list, entry.id, res))}
              className={`flex-1 rounded px-1 py-1.5 text-[12px] font-medium transition-colors ${
                entry.result === res ? RESULT_ACTIVE[res] : "text-muted hover:text-paper"
              }`}
            >
              {RESULT_LABEL[res]}
            </button>
          ))}
        </div>
        <span className={`num w-14 text-right text-[13px] ${r === null ? "text-muted" : r > 0 ? "text-buy" : "text-sell"}`}>
          {r === null ? "" : signedR(r)}
        </span>
      </div>
      <button
        type="button"
        onClick={() => updateHistory((list) => removeEntry(list, entry.id))}
        aria-label={`Delete ${label}`}
        className="mt-1.5 text-[12px] text-muted underline-offset-2 hover:text-paper hover:underline"
      >
        Delete
      </button>
    </li>
  );
}

export default function HistoryPanel() {
  const history = useSyncExternalStore(subscribeHistory, getHistorySnapshot, getServerHistorySnapshot);
  const stats = historyStats(history);
  const [filter, setFilter] = useState<SmcVerdict | "all">("all");
  const filtered = filter === "all" ? history : history.filter((e) => (e.smcVerdict ?? "unavailable") === filter);

  const clearAll = () => {
    if (window.confirm("Delete all saved signals from this browser?")) updateHistory(() => []);
  };

  return (
    <section aria-labelledby="history-title" className="rounded-[10px] border border-line bg-panel p-4 sm:p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="history-title" className="text-lg font-semibold text-paper">
          Signal history
        </h2>
        {history.length > 0 && (
          <button type="button" onClick={clearAll} className="text-[12px] text-muted hover:text-paper">
            Clear all
          </button>
        )}
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-2">
        <Stat label="Win rate" value={stats.winRate === null ? "n/a" : `${stats.winRate}%`} />
        <Stat label="Average R" value={stats.averageR === null ? "n/a" : signedR(stats.averageR)} />
        <Stat label="Closed" value={String(stats.closed)} detail={`${stats.wins} TP, ${stats.losses} SL`} />
      </dl>
      <p className="mt-2 text-[12px] leading-snug text-muted">
        A TP hit counts as TP1 reached and an SL hit as −1R. Open and skipped signals are left out.
      </p>

      {history.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {(["all", "agree", "neutral", "against", "unavailable"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={filter === v}
              onClick={() => setFilter(v)}
              className={`rounded px-2 py-1 text-[11px] font-medium ${filter === v ? "bg-raised text-paper" : "bg-ink/60 text-muted hover:text-paper"}`}
            >
              {v === "all" ? "All" : VERDICT_LABEL[v as SmcVerdict]}
            </button>
          ))}
        </div>
      )}

      {isMemoryOnly() && (
        <p className="mt-2 rounded bg-amber/15 px-2 py-1.5 text-[12px] text-amber">
          Browser storage is unavailable, so history only lasts until this tab closes.
        </p>
      )}

      {history.length === 0 ? (
        <p className="mt-4 border-t border-line pt-4 text-[14px] leading-snug text-muted">
          BUY and SELL signals are saved here. Mark each one as TP hit, SL hit or Skipped to track your win rate.
        </p>
      ) : filtered.length === 0 ? (
        <p className="mt-4 border-t border-line pt-4 text-[14px] text-muted">No signals match the selected filter.</p>
      ) : (
        <ol className="mt-3 max-h-[70vh] divide-y divide-line overflow-y-auto border-t border-line lg:max-h-[calc(100dvh-16rem)]">
          {filtered.map((e) => (
            <HistoryRow key={e.id} entry={e} />
          ))}
        </ol>
      )}
    </section>
  );
}
