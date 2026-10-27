/**
 * The analysis pipeline behind POST /api/signal:
 * fetch (parallel, cached) -> technicals in code -> hard gates -> AI -> validate -> SMC filter.
 * All I/O is injected so the whole flow is testable offline (tests/service.test.ts).
 */
import { MAX_OUTPUT_TOKENS, SYSTEM_PROMPT, buildUserPrompt } from "../ai/prompt";
import { AIError, type AIProvider } from "../ai/provider";
import { BUDGET, MODE_TIMEFRAMES, SYMBOL } from "../config";
import { fetchCalendar } from "../data/calendar";
import type { DataContext } from "../data/context";
import { fetchFredSeries, FRED_SERIES } from "../data/fred";
import { fetchCandles } from "../data/twelvedata";
import { summarizeCalendar, summarizeMacro } from "../fundamentals";
import type { CacheResult } from "../server/cache";
import type { TtlCache } from "../server/cache";
import type { ServerConfig } from "../server/env";
import { AppError, errorMessage, UpstreamError } from "../server/errors";
import type { FetchLike } from "../server/http";
import { InsufficientDataError, buildTechnicals } from "../technicals";
import { buildSmcSnapshot, smcToAiBlock } from "../smc";
import { applySmcFilter } from "../smc/filter";
import type { Candle, DataStatusItem, MacroSeries, Mode, SignalResponse, Timeframe, ValidatedSignal } from "../types";
import { preTradeGates } from "./gates";
import { ModelOutputError, parseModelSignal } from "./parse";
import { noTradeSignal, validateSignal, type SignalContext } from "./validate";

/** Time reserved after the AI call for validation and the response. */
const RESPONSE_MARGIN_MS = 300;

export interface ServiceDeps {
  config: ServerConfig;
  fetchImpl: FetchLike;
  cache: TtlCache;
  provider: AIProvider;
  /** Wall clock used for market time (defaults to Date.now). */
  now?: () => number;
  /** Clock used for the time budget (defaults to Date.now). */
  clock?: () => number;
}

function statusItem<T>(name: string, result: PromiseSettledResult<CacheResult<T>>): DataStatusItem {
  if (result.status === "rejected") {
    return { name, state: "missing", ageSeconds: null, detail: errorMessage(result.reason) };
  }
  const r = result.value;
  return { name, state: r.state, ageSeconds: Math.round(r.ageMs / 1000), detail: r.error };
}

function marketDataHint(error: unknown): string {
  if (error instanceof UpstreamError) {
    if (error.status === 429 || /rate limit/i.test(error.message)) {
      return "The free Twelve Data plan allows 8 requests per minute and each analysis uses 3. Wait a minute and try again.";
    }
    if (error.status === 401 || /api key/i.test(error.message)) {
      return "Check TWELVE_DATA_API_KEY in .env.local or your Vercel environment variables.";
    }
  }
  return "The market data provider did not answer in time. Try again in a moment.";
}

export async function generateSignal(mode: Mode, deps: ServiceDeps): Promise<SignalResponse> {
  const clock = deps.clock ?? Date.now;
  const startedAt = clock();
  const now = (deps.now ?? Date.now)();
  const ctx: DataContext = {
    config: deps.config,
    fetchImpl: deps.fetchImpl,
    cache: deps.cache,
    timeoutMs: BUDGET.upstreamTimeoutMs,
  };
  const timeframes = MODE_TIMEFRAMES[mode];
  const setupTimeframe = timeframes[1];

  // 1. Fetch everything in parallel; each source has its own timeout and fallback.
  const [candleResults, macroResults, calendarResult] = await Promise.all([
    Promise.allSettled(timeframes.map((tf) => fetchCandles(tf, ctx))),
    Promise.allSettled([fetchFredSeries(FRED_SERIES.realYield, ctx), fetchFredSeries(FRED_SERIES.usdIndex, ctx)]),
    fetchCalendar(ctx, now),
  ]);

  const dataStatus: DataStatusItem[] = [
    ...timeframes.map((tf, i) => statusItem(`Twelve Data ${tf}`, candleResults[i])),
    statusItem("FRED real yield", macroResults[0]),
    statusItem("FRED dollar index", macroResults[1]),
    {
      name: `Calendar (${calendarResult.source})`,
      state: calendarResult.state,
      ageSeconds: calendarResult.ageMs === null ? null : Math.round(calendarResult.ageMs / 1000),
      detail: calendarResult.note,
    },
  ];

  const candles: Partial<Record<Timeframe, Candle[]>> = {};
  timeframes.forEach((tf, i) => {
    const r = candleResults[i];
    if (r.status === "fulfilled") candles[tf] = r.value.value;
  });

  const setupResult = candleResults[1];
  if (setupResult.status === "rejected") {
    throw new AppError(
      502,
      "MARKET_DATA_UNAVAILABLE",
      `Could not load ${setupTimeframe} candles for ${SYMBOL}: ${errorMessage(setupResult.reason)}.`,
      marketDataHint(setupResult.reason),
    );
  }

  // 2. Technicals in code.
  let technicals: ReturnType<typeof buildTechnicals>;
  try {
    technicals = buildTechnicals(mode, candles);
  } catch (error) {
    if (error instanceof InsufficientDataError) {
      throw new AppError(502, "INSUFFICIENT_DATA", error.message, "The data provider returned too few candles. Try again later.");
    }
    throw error;
  }
  const tech = technicals.summary;
  const warnings = [...technicals.warnings];

  // 2b. SMC-lite snapshot (from same candles, no extra requests; pure local math)
  const smcSnapshot = buildSmcSnapshot(mode, candles, tech.price);
  const structureBlock = smcToAiBlock(smcSnapshot);

  // 3. Fundamentals in code.
  const macroValue = (r: PromiseSettledResult<CacheResult<MacroSeries>>) => (r.status === "fulfilled" ? r.value.value : null);
  const macro = summarizeMacro(macroValue(macroResults[0]), macroValue(macroResults[1]));
  const calendar = summarizeCalendar(calendarResult.events, now, calendarResult.source, calendarResult.note);
  const signalCtx: SignalContext = { tech, macro, calendar, now };

  for (const item of dataStatus) {
    if (item.state === "stale") warnings.push(`${item.name} is served from a ${item.ageSeconds}s old copy (${item.detail}).`);
  }

  // 4. Hard gates before spending an AI call.
  const priceIndex = tech.timeframes[0]?.role === "trigger" ? 0 : 1;
  const priceResult = candleResults[priceIndex];
  const gateReasons = preTradeGates({
    tech,
    calendar,
    now,
    priceState: priceResult.status === "fulfilled" ? priceResult.value.state : "fresh",
    priceError: priceResult.status === "fulfilled" ? priceResult.value.error : null,
    newsGate: deps.config.newsGate,
  });

  let signal: ValidatedSignal;
  let aiDurationMs: number | null = null;

  if (gateReasons.length > 0) {
    signal = noTradeSignal({ ctx: signalCtx, reasons: gateReasons, decidedBy: "rules" });
    // Tag NO_TRADE with SMC verdict as well (filters must not create trades, but we still tag)
    const filtered = applySmcFilter(signal, smcSnapshot);
    signal = filtered.signal;
  } else {
    const remaining = BUDGET.totalMs - (clock() - startedAt) - RESPONSE_MARGIN_MS;
    if (remaining < BUDGET.aiMinMs) {
      signal = noTradeSignal({
        ctx: signalCtx,
        reasons: ["The data sources were slow, leaving too little time for the AI step. Try again."],
        decidedBy: "rules",
      });
      const filtered = applySmcFilter(signal, smcSnapshot);
      signal = filtered.signal;
    } else {
      // 5. AI synthesis, then 6. validation of every number.
      const aiStart = clock();
      try {
        const text = await deps.provider.complete({
          system: SYSTEM_PROMPT,
          user: buildUserPrompt(tech, macro, calendar, now, structureBlock),
          maxTokens: MAX_OUTPUT_TOKENS,
          timeoutMs: Math.min(BUDGET.aiMaxMs, remaining),
        });
        aiDurationMs = clock() - aiStart;
        signal = validateSignal(parseModelSignal(text), signalCtx);
        // 6b. SMC filter: confidence-only penalties after validation (FILTERS ONLY)
        const filtered = applySmcFilter(signal, smcSnapshot);
        signal = filtered.signal;
      } catch (error) {
        aiDurationMs = clock() - aiStart;
        if (error instanceof AIError && (error.kind === "auth" || error.kind === "model_not_found" || error.kind === "bad_request")) {
          // Provider auth errors can echo part of the key (e.g. "sk-…abcd"): log them, show a generic message.
          if (error.kind === "auth") console.error(`[api/signal] AI provider auth error: ${error.message}`);
          const message =
            error.kind === "auth"
              ? `The AI provider rejected the API key (HTTP ${error.status ?? "401"}).`
              : error.message;
          throw new AppError(
            502,
            "AI_CONFIG",
            message,
            "Check AI_PROVIDER, AI_MODEL, AI_THINKING and the provider API key, then restart or redeploy.",
          );
        }
        if (error instanceof AIError) {
          signal = noTradeSignal({ ctx: signalCtx, reasons: [`AI analysis unavailable: ${error.message}.`], decidedBy: "rules" });
          const filtered = applySmcFilter(signal, smcSnapshot);
          signal = filtered.signal;
        } else if (error instanceof ModelOutputError) {
          signal = noTradeSignal({
            ctx: signalCtx,
            reasons: [`${error.message} No AI levels were used.`],
            decidedBy: "rules",
          });
          const filtered = applySmcFilter(signal, smcSnapshot);
          signal = filtered.signal;
        } else {
          throw error;
        }
      }
    }
  }

  signal = { ...signal, warnings: [...warnings, ...signal.warnings] };

  return {
    signal,
    snapshot: {
      symbol: SYMBOL,
      mode,
      generatedAt: new Date(now).toISOString(),
      price: tech.price,
      priceTime: new Date(tech.priceTime).toISOString(),
      priceTimeframe: tech.priceTimeframe,
      setupTimeframe: tech.setupTimeframe,
      atr: tech.atr,
      timeframes: tech.timeframes,
      macro,
      calendar,
      dataStatus,
      structure: structureBlock,
    },
    meta: {
      provider: deps.provider.name,
      model: deps.provider.model,
      durationMs: clock() - startedAt,
      aiDurationMs,
    },
  };
}
