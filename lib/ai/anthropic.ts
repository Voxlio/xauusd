/**
 * Anthropic Messages API via fetch (no SDK). No temperature (newer models reject
 * sampling params) and no assistant prefill. Claude 5-family models think by
 * default; with AI_THINKING=off (default) thinking is disabled to stay inside
 * the 10 s function budget.
 */
import type { AIConfig } from "../server/env";
import type { FetchLike } from "../server/http";
import { isRecord } from "../server/http";
import { AIError, kindFromStatus, postJson, type AIProvider } from "./provider";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";
/** Extra output budget when the model is allowed to think (thinking tokens count toward max_tokens). */
const THINKING_HEADROOM_TOKENS = 3000;

function errorDetail(data: unknown): string {
  if (isRecord(data) && isRecord(data.error) && typeof data.error.message === "string") {
    return data.error.message.slice(0, 200);
  }
  return typeof data === "string" ? data.slice(0, 200) : "no details";
}

/** Joins every text block; ignores thinking/tool blocks if a model returns them. */
export function extractAnthropicText(data: unknown): string {
  if (!isRecord(data) || !Array.isArray(data.content)) return "";
  return data.content
    .filter((b): b is { type: string; text: string } => isRecord(b) && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export function buildAnthropicBody(config: AIConfig, system: string, user: string, maxTokens: number) {
  const thinkingOff = config.thinking === "off";
  return {
    model: config.model,
    max_tokens: thinkingOff ? maxTokens : maxTokens + THINKING_HEADROOM_TOKENS,
    system,
    messages: [{ role: "user", content: user }],
    ...(thinkingOff ? { thinking: { type: "disabled" } } : {}),
  };
}

export function createAnthropicProvider(config: AIConfig, fetchImpl: FetchLike): AIProvider {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  return {
    name: "anthropic",
    model: config.model,
    async complete({ system, user, maxTokens, timeoutMs }) {
      const { status, data } = await postJson(
        fetchImpl,
        `${baseUrl}/v1/messages`,
        { "x-api-key": config.apiKey, "anthropic-version": API_VERSION },
        buildAnthropicBody(config, system, user, maxTokens),
        timeoutMs,
        "Anthropic",
      );
      if (status < 200 || status >= 300) {
        const kind = kindFromStatus(status);
        const hint =
          kind === "auth"
            ? " (check ANTHROPIC_API_KEY)"
            : kind === "model_not_found"
              ? ` (check AI_MODEL "${config.model}")`
              : "";
        throw new AIError(kind, `Anthropic API error ${status}: ${errorDetail(data)}${hint}`, status);
      }
      const text = extractAnthropicText(data);
      if (!text) {
        const stop = isRecord(data) && typeof data.stop_reason === "string" ? data.stop_reason : "unknown";
        throw new AIError("empty", `Anthropic returned no text (stop_reason: ${stop})`, status);
      }
      return text;
    },
  };
}
