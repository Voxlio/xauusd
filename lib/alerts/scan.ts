/**
 * Framework-agnostic handler for POST /api/cron/scan (Request in, Response out).
 * Flow: auth -> mode -> cheap code-only checks -> the same pipeline as /api/signal -> alert rules -> Telegram -> Redis.
 * All I/O is injected, so tests run offline. app/api/cron/scan/route.ts delegates here.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createProvider as defaultCreateProvider, type AIProvider } from "../ai/provider";
import { goldMarketSession } from "../marketHours";
import { dataCache, type TtlCache } from "../server/cache";
import { readAlertConfig, readConfig, type AIConfig, type AlertConfig, type Env } from "../server/env";
import { AppError } from "../server/errors";
import type { FetchLike } from "../server/http";
import { generateSignal } from "../signal/service";
import type { Mode, SignalResponse } from "../types";
import { evaluateAlert, isAlertSession, trendVotesFullyMixed } from "./rules";
import { createRedisStore, LOCK_TTL_SECONDS, type AlertSide, type AlertStore } from "./store";
import { formatAlertMessage, sendTelegramMessage, type SendTelegram } from "./telegram";

export interface ScanDeps {
  env: Env;
  fetchImpl: FetchLike;
  cache: TtlCache;
  createProvider: (config: AIConfig, fetchImpl: FetchLike) => AIProvider;
  /** Runs the existing pipeline (same function /api/signal uses). */
  generate: typeof generateSignal;
  /** Returns null when Redis is not configured. */
  createStore: (config: AlertConfig, fetchImpl: FetchLike) => AlertStore | null;
  sendTelegram: SendTelegram;
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

const skipped = (reason: string, extra: Record<string, unknown> = {}): Response => json(200, { status: "skipped", reason, ...extra });
const failed = (status: number, code: string, message: string): Response => json(status, { status: "error", code, message });

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
function redactSecrets(text: string, env: Env): string {
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
    sendTelegram: sendTelegramMessage,
    now: Date.now,
    clock: Date.now,
    ...overrides,
  };

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
    if (!mode) return failed(400, "INVALID_MODE", 'Send mode as ?mode=day or ?mode=swing.');

    const config = readConfig(deps.env);
    const alerts = readAlertConfig(deps.env);
    if (!alerts.telegramToken || !alerts.telegramChatId) {
      return failed(500, "CONFIG_MISSING", "Server is missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID.");
    }
    const store = deps.createStore(alerts, deps.fetchImpl);
    if (!store) return failed(503, "STORE_UNAVAILABLE", "Alert state store (Redis) is not configured; nothing was sent.");

    // Free checks before any data credits or AI tokens are spent.
    const now = deps.now();
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

      // Lock so two overlapping runs cannot both send, then re-check with fresh state.
      if (!(await store.acquireLock(mode, side, LOCK_TTL_SECONDS))) return skipped("duplicate_lock");
      let sent = false;
      try {
        const second = await decide();
        if (!second.send) return skipped(second.reason);
        await deps.sendTelegram({
          token: alerts.telegramToken,
          chatId: alerts.telegramChatId,
          text: formatAlertMessage(signal, mode, now),
          fetchImpl: deps.fetchImpl,
        });
        sent = true;
        await store.saveLast(mode, side, { entry: signal.entry as number, at: now, confidence: signal.confidence as number }, alerts.cooldownHours * 3600);
        return json(200, { status: "sent", mode, side, confidence: signal.confidence, reason: second.reason });
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
