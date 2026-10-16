/**
 * Framework-agnostic handler for POST /api/signal (Request in, Response out),
 * so it can be tested without Next.js. app/api/signal/route.ts delegates here.
 */
import { createProvider as defaultCreateProvider, type AIProvider } from "../ai/provider";
import { generateSignal } from "../signal/service";
import { MAX_BODY_BYTES, parseSignalRequest } from "../signal/request";
import { dataCache, type TtlCache } from "./cache";
import { readConfig, type AIConfig, type Env } from "./env";
import { AppError } from "./errors";
import type { FetchLike } from "./http";
import { clientKey, RateLimiter } from "./rateLimit";
import type { ApiErrorBody } from "../types";

export interface HandlerDeps {
  env: Env;
  fetchImpl: FetchLike;
  cache: TtlCache;
  limiter: RateLimiter | null;
  createProvider: (config: AIConfig, fetchImpl: FetchLike) => AIProvider;
  now: () => number;
  clock: () => number;
}

let sharedLimiter: RateLimiter | null = null;

function limiterFor(limit: number): RateLimiter {
  if (!sharedLimiter || sharedLimiter.limit !== limit) sharedLimiter = new RateLimiter(limit);
  return sharedLimiter;
}

const BASE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...extra } });
}

function errorResponse(error: AppError, extra: Record<string, string> = {}): Response {
  const body: ApiErrorBody = { error: { code: error.code, message: error.message, hint: error.hint } };
  return json(error.status, body, extra);
}

/** Replaces any configured secret (*_KEY env values) in a log line. */
export function redact(text: string, env: Env): string {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    if (/_KEY$/.test(name) && value && value.trim().length >= 6) out = out.split(value.trim()).join("[redacted]");
  }
  return out;
}

/** Rejects browser requests from other sites (a cheap guard for your API credits). */
function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new AppError(403, "FORBIDDEN_ORIGIN", "Invalid Origin header.");
  }
  if (!host || originHost !== host.split(",")[0].trim()) {
    throw new AppError(403, "FORBIDDEN_ORIGIN", "Cross-site requests are not allowed.", "Call the API from the app's own page.");
  }
}

export async function handleSignalRequest(request: Request, overrides: Partial<HandlerDeps> = {}): Promise<Response> {
  const deps: HandlerDeps = {
    env: process.env,
    fetchImpl: fetch,
    cache: dataCache,
    limiter: null,
    createProvider: defaultCreateProvider,
    now: Date.now,
    clock: Date.now,
    ...overrides,
  };

  try {
    if (request.method !== "POST") {
      throw new AppError(405, "METHOD_NOT_ALLOWED", "Use POST.", 'POST a JSON body like {"mode":"day"}.');
    }
    assertSameOrigin(request);

    const config = readConfig(deps.env);
    const limiter = deps.limiter ?? limiterFor(config.rateLimitPerMinute);
    const limit = limiter.check(clientKey(request.headers));
    if (!limit.allowed) {
      return errorResponse(
        new AppError(
          429,
          "RATE_LIMITED",
          `Too many analyses. Try again in ${limit.retryAfterSeconds} seconds.`,
          "The limit protects your free API credits. Adjust RATE_LIMIT_PER_MINUTE if needed.",
        ),
        { "retry-after": String(limit.retryAfterSeconds) },
      );
    }

    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_BODY_BYTES) {
      throw new AppError(413, "PAYLOAD_TOO_LARGE", `Request body must be at most ${MAX_BODY_BYTES} bytes.`);
    }
    const { mode } = parseSignalRequest(request.headers.get("content-type"), await request.text());

    const provider = deps.createProvider(config.ai, deps.fetchImpl);
    const result = await generateSignal(mode, {
      config,
      fetchImpl: deps.fetchImpl,
      cache: deps.cache,
      provider,
      now: deps.now,
      clock: deps.clock,
    });
    return json(200, result);
  } catch (error) {
    if (error instanceof AppError) {
      if (error.status >= 500) console.error(`[api/signal] ${error.code}: ${redact(error.message, deps.env)}`);
      return errorResponse(error, error.status === 405 ? { allow: "POST" } : {});
    }
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[api/signal] Unexpected error: ${redact(detail, deps.env)}`);
    return errorResponse(
      new AppError(500, "INTERNAL_ERROR", "Unexpected server error while building the signal.", "Try again. If it keeps failing, check the function logs."),
    );
  }
}
