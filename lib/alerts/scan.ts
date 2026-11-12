/**
 * Framework-agnostic handler for POST /api/cron/scan (Request in, Response out).
 * Flow: auth -> mode -> config -> call tracker (open calls) -> cheap code-only checks -> the same pipeline as
 * /api/signal -> alert rules -> new call + Telegram -> Redis. The tracker and the scan fail independently.
 * All I/O is injected, so tests run offline. app/api/cron/scan/route.ts delegates here.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createProvider as defaultCreateProvider, type AIProvider } from "../ai/provider";
import { BUDGET } from "../config";
import { createRedisCallStore, type CallStore } from "../calls/store";
import { runTracker, type TrackerSummary } from "../calls/run";
import type { Call } from "../calls/types";
import { goldMarketSession } from "../marketHours";
import { dataCache, type TtlCache } from "../server/cache";
import { readAlertConfig, readConfig, type AIConfig, type AlertConfig, type Env } from "../server/env";
import { AppError } from "../server/errors";
import type { FetchLike } from "../server/http";
import { generateSignal } from "../signal/service";
import type { Mode, SignalResponse } from "../types";
import { formatNewCallMessage, navKeyboard } from "./format";
import { evaluateAlert, isAlertSession, trendVotesFullyMixed, VALID_FOR_MS } from "./rules";
import { createRedisStore, LOCK_TTL_SECONDS, type AlertSide, type AlertStore } from "./store";
import { sendMessage, type SendTelegram } from "./telegram";

export interface ScanDeps {
  env: Env;
  fetchImpl: FetchLike;
  cache: TtlCache;
  createProvider: (config: AIConfig, fetchImpl: FetchLike) => AIProvider;
  /** Runs the existing pipeline (same function /api/signal uses). */
  generate: typeof generateSignal;
  /** Returns null when Redis is not configured. */
  createStore: (config: AlertConfig, fetchImpl: FetchLike) => AlertStore | null;
  createCallStore: (config: AlertConfig, fetchImpl: FetchLike) => CallStore | null;
  sendTelegram: SendTelegram;
  newId: () => string;
  now: () => number;
  clock: () => number;
}

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
}

/** Constant-time comparison of two secrets (hashing first hides length differences). */
export function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function bearer(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : "";
}

async function readMode(request: Request): Promise<Mode | null> {
  const fromQuery = new URL(request.url).searchParams.get("mode");
  let raw: unknown = fromQuery;
  if (raw === null) {
    try {
      const text = await request.text();
      raw = text.trim() === "" ? null : (JSON.parse(text) as { mode?: unknown } | null)?.mode;
    } catch {
      raw = null;
    }
  }
  return raw === "day" || raw === "swing" ? raw : null;
}

/** Removes configured secrets from a log line. */
export function redactSecrets(text: string, env: Env): string {
  let out = text;
  for (const [name, v] of Object.entries(env)) {
    if (/(_KEY|_TOKEN|_SECRET)$/.test(name) && v && v.trim().length >= 6) out = out.split(v.trim()).join("[redacted]");
  }
  return out;
}

export async function handleScanRequest(request: Request, overrides: Partial<ScanDeps> = {}): Promise<Response> {
  const deps: ScanDeps = {
    env: process.env,
    fetchImpl: fetch,
    cache: dataCache,
    createProvider: defaultCreateProvider,
    generate: generateSignal,
    createStore: (c, fetchImpl) => (c.redisUrl && c.redisToken ? createRedisStore({ url: c.redisUrl, token: c.redisToken, fetchImpl }) : null),
    createCallStore: (c, fetchImpl) => (c.redisUrl && c.redisToken ? createRedisCallStore({ url: c.redisUrl, token: c.redisToken, fetchImpl }) : null),
    sendTelegram: sendMessage,
    newId: () => randomBytes(3).toString("hex").toUpperCase(),
    now: Date.now,
    clock: Date.now,
    ...overrides,
  };

  // Shown in every response once the tracker has done something (or failed).
  let tracker: TrackerSummary | null = null;
  const body = (b: Record<string, unknown>) => (tracker ? { ...b, tracker } : b);
  const skipped = (reason: string): Response => json(200, body({ status: "skipped", reason }));
  const failed = (status: number, code: string, message: string): Response => json(status, body({ status: "error", code, message }));

  try {
    if (request.method !== "POST") {
      return json(405, { status: "error", code: "METHOD_NOT_ALLOWED", message: "Use POST." }, { allow: "POST" });
    }

    // Auth first, and fail closed when CRON_SECRET is not configured.
    const secret = (deps.env.CRON_SECRET ?? "").trim();
    const provided = bearer(request);
    if (secret === "" || provided === "" || !secretsMatch(provided, secret)) {
      return failed(401, "UNAUTHORIZED", "Missing or invalid credentials.");
    }

    const mode = await readMode(request);
    if (!mode) return failed(400, "INVALID_MODE", "Send mode as ?mode=day or ?mode=swing.");

    const config = readConfig(deps.env);
    const alerts = readAlertConfig(deps.env);
    if (!alerts.telegramToken || !alerts.telegramChatId) {
      return failed(500, "CONFIG_MISSING", "Server is missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID.");
    }
    const { telegramToken, telegramChatId } = alerts;
    const store = deps.createStore(alerts, deps.fetchImpl);
    const callStore = deps.createCallStore(alerts, deps.fetchImpl);
    if (!store || !callStore) return failed(503, "STORE_UNAVAILABLE", "Alert state store (Redis) is not configured; nothing was sent.");

    const now = deps.now();
    const send: SendTelegram = (o) => deps.sendTelegram(o);

    // 1. Follow open calls. Its failure never blocks the scan below.
    try {
      const summary = await runTracker({
        store: callStore,
        ctx: { config, fetchImpl: deps.fetchImpl, cache: deps.cache, timeoutMs: BUDGET.upstreamTimeoutMs },
        now,
        clock: deps.clock,
        send: (text, replyMarkup) => send({ token: telegramToken, chatId: telegramChatId, text, fetchImpl: deps.fetchImpl, replyMarkup }),
      });
      if (summary.checked > 0 || summary.error || summary.note) tracker = summary;
    } catch (error) {
      const name = error instanceof Error ? error.name : "Error";
      console.error(`[api/cron/scan] tracker ${name}: ${error instanceof Error ? redactSecrets(error.message, deps.env) : "unknown"}`);
      tracker = { checked: 0, events: 0, error: "tracker_failed" };
    }

    // 2. New-signal scan. Free checks first, before any data credits or AI tokens are spent.
    if (!goldMarketSession(now).open) return skipped("market_closed");
    if (alerts.sessionsOnly && !isAlertSession(now)) return skipped("outside_session");

    // Code-only pre-check inside the pipeline: skip the AI when timeframes are fully mixed.
    const pre = { reason: null as string | null };
    const result: SignalResponse = await deps.generate(mode, {
      config,
      fetchImpl: deps.fetchImpl,
      cache: deps.cache,
      provider: deps.createProvider(config.ai, deps.fetchImpl),
      now: deps.now,
      clock: deps.clock,
      skipAi: (tech) => {
        if (trendVotesFullyMixed(tech.alignment)) {
          pre.reason = "trend_votes_mixed";
          return "Timeframe trend votes are fully mixed; the AI step was skipped by the alert pre-check.";
        }
        return null;
      },
    });
    const { signal, snapshot } = result;
    if (pre.reason) return skipped(pre.reason);
    if (signal.bias !== "BUY" && signal.bias !== "SELL") {
      return skipped(signal.decidedBy === "rules" ? "gate_no_trade" : "no_trade");
    }
    const side: AlertSide = signal.bias;
    const settings = { minConfidence: alerts.minConfidence, cooldownHours: alerts.cooldownHours, sessionsOnly: alerts.sessionsOnly };
    const decide = async () =>
      evaluateAlert({ mode, signal, atr: snapshot.atr, now, last: await store.getLast(mode, side), settings });

    try {
      const first = await decide();
      if (!first.send) return skipped(first.reason);
      if (signal.entry === null || signal.stopLoss === null || signal.takeProfit1 === null || signal.takeProfit2 === null || signal.confidence === null) {
        return skipped("incomplete_levels");
      }

      // Lock so two overlapping runs cannot both send, then re-check with fresh state.
      if (!(await store.acquireLock(mode, side, LOCK_TTL_SECONDS))) return skipped("duplicate_lock");
      let sent = false;
      try {
        const second = await decide();
        if (!second.send) return skipped(second.reason);

        const call: Call = {
          id: deps.newId(),
          mode,
          side,
          entry: signal.entry,
          stopLoss: signal.stopLoss,
          tp1: signal.takeProfit1,
          tp2: signal.takeProfit2,
          confidence: signal.confidence,
          smcVerdict: signal.smcVerdict ?? "unavailable",
          createdAt: now,
          validUntil: now + VALID_FOR_MS[mode],
          status: "PENDING",
          lastCheckedAt: now,
        };
        // The call exists before the message, so its id is real; it is removed again if the send fails.
        await callStore.create(call);
        try {
          await send({
            token: telegramToken,
            chatId: telegramChatId,
            text: formatNewCallMessage(call, signal),
            fetchImpl: deps.fetchImpl,
            replyMarkup: navKeyboard(),
          });
        } catch (error) {
          await callStore.remove(call.id).catch(() => undefined);
          throw error;
        }
        sent = true;
        await store.saveLast(mode, side, { entry: call.entry, at: now, confidence: call.confidence }, alerts.cooldownHours * 3600);
        return json(200, body({ status: "sent", mode, side, confidence: call.confidence, reason: second.reason, callId: call.id }));
      } finally {
        // Keep the lock after a successful send (it expires on its own); otherwise free it so the next scan can retry.
        if (!sent) await store.releaseLock(mode, side).catch(() => undefined);
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      const name = error instanceof Error ? error.name : "Error";
      const detail = error instanceof Error ? redactSecrets(error.message, deps.env) : "unknown";
      console.error(`[api/cron/scan] ${name}: ${detail}`);
      if (name === "StoreError") return failed(503, "STORE_UNAVAILABLE", "Alert state store (Redis) failed; nothing was sent.");
      if (name === "TelegramError") return failed(502, "TELEGRAM_FAILED", "Telegram did not accept the message.");
      return failed(500, "INTERNAL_ERROR", "Unexpected error while sending the alert.");
    }
  } catch (error) {
    if (error instanceof AppError) {
      if (error.status >= 500) console.error(`[api/cron/scan] ${error.code}: ${redactSecrets(error.message, deps.env)}`);
      return failed(error.status, error.code, error.message);
    }
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[api/cron/scan] Unexpected error: ${redactSecrets(detail, deps.env)}`);
    return failed(500, "INTERNAL_ERROR", "Unexpected server error during the scan.");
  }
}
