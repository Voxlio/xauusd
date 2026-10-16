/**
 * Minimal AI provider contract. Swap providers with AI_PROVIDER / AI_MODEL;
 * nothing else in the app knows which vendor is used.
 */
import type { AIConfig } from "../server/env";
import type { FetchLike } from "../server/http";
import { createAnthropicProvider } from "./anthropic";
import { createOpenAIProvider } from "./openai";

export interface AICompletionRequest {
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
}

export interface AIProvider {
  readonly name: string;
  readonly model: string;
  /** Returns the raw text of the model's reply. */
  complete(request: AICompletionRequest): Promise<string>;
}

export type AIErrorKind =
  | "timeout"
  | "network"
  | "auth"
  | "rate_limit"
  | "overloaded"
  | "model_not_found"
  | "bad_request"
  | "server"
  | "empty";

export class AIError extends Error {
  readonly kind: AIErrorKind;
  readonly status: number | null;

  constructor(kind: AIErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = "AIError";
    this.kind = kind;
    this.status = status;
  }
}

export function kindFromStatus(status: number): AIErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "model_not_found";
  if (status === 429) return "rate_limit";
  if (status === 529 || status === 503) return "overloaded";
  if (status >= 500) return "server";
  return "bad_request";
}

/** Shared POST-with-timeout used by provider implementations. */
export async function postJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  label: string,
): Promise<{ status: number; data: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new AIError("timeout", `${label} did not answer within ${(timeoutMs / 1000).toFixed(1)}s`);
      }
      throw new AIError("network", `${label} could not be reached (${error instanceof Error ? error.message : "network error"})`);
    }
    let text = "";
    try {
      text = await response.text();
    } catch {
      throw new AIError(controller.signal.aborted ? "timeout" : "network", `${label} response could not be read`, response.status);
    }
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

export function createProvider(config: AIConfig, fetchImpl: FetchLike = fetch): AIProvider {
  switch (config.provider) {
    case "anthropic":
      return createAnthropicProvider(config, fetchImpl);
    case "openai":
      return createOpenAIProvider(config, fetchImpl);
  }
}
