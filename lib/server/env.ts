/** Reads and validates server-side environment variables. Never import from client code. */
import { AppError } from "./errors";

export type AIProviderName = "anthropic" | "openai";

export const DEFAULT_MODELS: Record<AIProviderName, string> = {
  anthropic: "claude-haiku-5-5",
  openai: "gpt-4.1-mini",
};

export interface AIConfig {
  provider: AIProviderName;
  model: string;
  apiKey: string;
  baseUrl: string | null;
  /** "off" sends thinking disabled (fastest); "auto" leaves the model default (Claude 5+ think by default). */
  thinking: "off" | "auto";
}

export interface ServerConfig {
  twelveDataKey: string;
  fredKey: string | null;
  finnhubKey: string | null;
  calendarFallback: "forexfactory" | "none";
  /** "strict": NO TRADE when no calendar source loads. "warn": trade with a warning. */
  newsGate: "strict" | "warn";
  ai: AIConfig;
  cacheTtlMs: number;
  rateLimitPerMinute: number;
}

export type Env = Record<string, string | undefined>;

const ENV_HINT =
  "Set it in .env.local for local runs, or in Vercel > Project > Settings > Environment Variables, then restart or redeploy.";

function value(env: Env, name: string): string | null {
  const raw = env[name];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

function required(env: Env, name: string, purpose: string): string {
  const v = value(env, name);
  if (!v) {
    throw new AppError(500, "CONFIG_MISSING", `Server is missing ${name} (${purpose}).`, ENV_HINT);
  }
  return v;
}

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const v = value(env, name);
  if (v === null) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new AppError(500, "CONFIG_INVALID", `${name} must be an integer between ${min} and ${max}.`, ENV_HINT);
  }
  return n;
}

function baseUrl(env: Env): string | null {
  const v = value(env, "AI_BASE_URL");
  if (v === null) return null;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new AppError(500, "CONFIG_INVALID", "AI_BASE_URL is not a valid URL.", ENV_HINT);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new AppError(500, "CONFIG_INVALID", "AI_BASE_URL must use https (http is allowed only for localhost).", ENV_HINT);
  }
  return v.replace(/\/+$/, "");
}

export function readConfig(env: Env = process.env): ServerConfig {
  const twelveDataKey = required(env, "TWELVE_DATA_API_KEY", "XAU/USD candles");

  const providerRaw = (value(env, "AI_PROVIDER") ?? "anthropic").toLowerCase();
  if (providerRaw !== "anthropic" && providerRaw !== "openai") {
    throw new AppError(500, "CONFIG_INVALID", `AI_PROVIDER must be "anthropic" or "openai", got "${providerRaw}".`, ENV_HINT);
  }
  const provider: AIProviderName = providerRaw;
  const model = value(env, "AI_MODEL") ?? DEFAULT_MODELS[provider];
  if (!/^[A-Za-z0-9._:/@-]{1,120}$/.test(model)) {
    throw new AppError(500, "CONFIG_INVALID", "AI_MODEL contains unsupported characters.", ENV_HINT);
  }
  const apiKey =
    provider === "anthropic"
      ? required(env, "ANTHROPIC_API_KEY", "Anthropic AI provider")
      : required(env, "OPENAI_API_KEY", "OpenAI-compatible AI provider");

  const fallbackRaw = (value(env, "CALENDAR_FALLBACK") ?? "forexfactory").toLowerCase();
  if (fallbackRaw !== "forexfactory" && fallbackRaw !== "none") {
    throw new AppError(500, "CONFIG_INVALID", 'CALENDAR_FALLBACK must be "forexfactory" or "none".', ENV_HINT);
  }

  const thinkingRaw = (value(env, "AI_THINKING") ?? "off").toLowerCase();
  if (thinkingRaw !== "off" && thinkingRaw !== "auto") {
    throw new AppError(500, "CONFIG_INVALID", 'AI_THINKING must be "off" or "auto".', ENV_HINT);
  }

  const newsGateRaw = (value(env, "NEWS_GATE") ?? "strict").toLowerCase();
  if (newsGateRaw !== "strict" && newsGateRaw !== "warn") {
    throw new AppError(500, "CONFIG_INVALID", 'NEWS_GATE must be "strict" or "warn".', ENV_HINT);
  }

  return {
    twelveDataKey,
    fredKey: value(env, "FRED_API_KEY"),
    finnhubKey: value(env, "FINNHUB_API_KEY"),
    calendarFallback: fallbackRaw,
    newsGate: newsGateRaw,
    ai: { provider, model, apiKey, baseUrl: baseUrl(env), thinking: thinkingRaw },
    cacheTtlMs: integer(env, "CACHE_TTL_SECONDS", 60, 5, 300) * 1000,
    rateLimitPerMinute: integer(env, "RATE_LIMIT_PER_MINUTE", 10, 1, 120),
  };
}
