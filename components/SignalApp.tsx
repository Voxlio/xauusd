"use client";

import { useRef, useState } from "react";
import { ClientError, requestSignal } from "@/lib/clientApi";
import { DISCLAIMER } from "@/lib/config";
import { addEntry, entryFromResponse } from "@/lib/history";
import { updateHistory } from "@/lib/historyStore";
import { formatPrice } from "@/lib/num";
import { formatUtc } from "@/lib/time";
import type { Mode, SignalResponse } from "@/lib/types";
import AnalyzeButton from "./AnalyzeButton";
import HistoryPanel from "./HistoryPanel";
import ModeToggle from "./ModeToggle";
import ResultCard from "./ResultCard";

/** Client-side ceiling; the server answers within ~9 s. */
const CLIENT_TIMEOUT_MS = 20_000;

interface UiError {
  message: string;
  hint: string;
}

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function SignalApp() {
  const [mode, setMode] = useState<Mode>("day");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SignalResponse | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const inflight = useRef<AbortController | null>(null);

  async function analyze() {
    if (inflight.current) return;
    const controller = new AbortController();
    inflight.current = controller;
    const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
    setLoading(true);
    setError(null);
    try {
      const data = await requestSignal(mode, controller.signal);
      setResult(data);
      const entry = entryFromResponse(data, newId());
      if (entry) updateHistory((list) => addEntry(list, entry));
    } catch (e) {
      setError(
        e instanceof ClientError
          ? { message: e.message, hint: e.hint }
          : { message: "Something went wrong while analyzing.", hint: "Try again." },
      );
    } finally {
      clearTimeout(timer);
      inflight.current = null;
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-4 pt-6 sm:px-6 lg:px-8 lg:pt-10">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-line pb-5">
        <div>
          <h1 className="hallmark text-[length:clamp(2.75rem,12vw,5rem)] font-extrabold leading-[0.95] text-paper">XAU/USD</h1>
          <p className="mt-2 text-[15px] text-muted">Gold spot vs US Dollar</p>
        </div>
        {result && (
          <div className="text-left sm:text-right">
            <p className="num text-2xl font-semibold text-paper sm:text-3xl">{formatPrice(result.snapshot.price)}</p>
            <p className="text-[12px] text-muted">
              Close of the {result.snapshot.priceTimeframe} candle opened{" "}
              <time dateTime={result.snapshot.priceTime}>{formatUtc(Date.parse(result.snapshot.priceTime))}</time>
            </p>
          </div>
        )}
      </header>

      <div className="mt-6 grid flex-1 items-start gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <main className="min-w-0 space-y-5">
          <ModeToggle mode={mode} disabled={loading} onChange={setMode} />
          <AnalyzeButton loading={loading} onClick={analyze} />

          <div aria-live="polite" className="space-y-5">
            {error && (
              <div role="alert" className="rounded-[10px] border border-sell/50 bg-sell/10 p-4">
                <p className="text-[15px] font-semibold text-paper">{error.message}</p>
                <p className="mt-1 text-[14px] text-paper/80">{error.hint}</p>
                <button
                  type="button"
                  onClick={analyze}
                  disabled={loading}
                  className="mt-3 rounded-md border border-paper/30 px-3 py-1.5 text-[14px] font-medium text-paper hover:bg-paper/10 disabled:opacity-50"
                >
                  Try again
                </button>
              </div>
            )}

            {result ? (
              <ResultCard data={result} dimmed={loading} />
            ) : (
              !error && (
                <div className="rounded-[10px] border border-dashed border-line px-4 py-8 text-[15px] leading-relaxed text-muted sm:px-6">
                  <p className="max-w-prose">
                    Pick Day or Swing, then press Analyze. You get a bias with entry, stop loss and two targets, or a
                    clear reason not to trade.
                  </p>
                  <p className="mt-2 max-w-prose">
                    Indicators, levels and risk rules are computed in code; the AI weighs them with real yields, the
                    dollar and the USD calendar.
                  </p>
                </div>
              )
            )}
          </div>
        </main>

        <aside className="min-w-0 lg:sticky lg:top-6">
          <HistoryPanel />
        </aside>
      </div>

      <footer className="mt-10 border-t border-line py-5 text-[13px] text-muted">{DISCLAIMER}</footer>
    </div>
  );
}
