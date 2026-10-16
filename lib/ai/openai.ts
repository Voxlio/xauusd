/**
 * OpenAI Chat Completions (and any compatible host via AI_BASE_URL, e.g. Groq,
 * OpenRouter, Together, a local server). Uses JSON mode and no sampling params.
 * Prefer non-reasoning models: reasoning tokens count toward the output limit
 * and can leave an empty reply within the 10 s budget.
 */
import type { AIConfig } from "../server/env";
import type { FetchLike } from "../server/http";
import { isRecord } from "../server/http";
import { AIError, kindFromStatus, postJson, type AIProvider } from "./provider";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

function errorDetail(data: unknown): string {
  if (isRecord(data) && isRecord(data.error) && typeof data.error.message === "string") {
    return data.error.message.slice(0, 200);
  }
  return typeof data === "string" ? data.slice(0, 200) : "no details";
}

export function extractOpenAIText(data: unknown): string {
  if (!isRecord(data) || !Array.isArray(data.choices) || data.choices.length === 0) return "";
  const choice = data.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return "";
  const content = choice.message.content;
  return typeof content === "string" ? content.trim() : "";
}

export function createOpenAIProvider(config: AIConfig, fetchImpl: FetchLike): AIProvider {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  return {
    name: "openai",
    model: config.model,
    async complete({ system, user, maxTokens, timeoutMs }) {
      const { status, data } = await postJson(
        fetchImpl,
        `${baseUrl}/chat/completions`,
        { authorization: `Bearer ${config.apiKey}` },
        {
          model: config.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          max_completion_tokens: maxTokens,
          response_format: { type: "json_object" },
        },
        timeoutMs,
        "OpenAI-compatible API",
      );
      if (status < 200 || status >= 300) {
        const kind = kindFromStatus(status);
        const hint =
          kind === "auth"
            ? " (check OPENAI_API_KEY)"
            : kind === "model_not_found"
              ? ` (check AI_MODEL "${config.model}")`
              : "";
        throw new AIError(kind, `AI API error ${status}: ${errorDetail(data)}${hint}`, status);
      }
      const text = extractOpenAIText(data);
      if (!text) {
        const choice = isRecord(data) && Array.isArray(data.choices) && isRecord(data.choices[0]) ? data.choices[0] : null;
        const finish = choice && typeof choice.finish_reason === "string" ? choice.finish_reason : "unknown";
        const hint = finish === "length" ? "; the output limit was reached, try a non-reasoning model" : "";
        throw new AIError("empty", `AI API returned an empty message (finish_reason: ${finish}${hint})`, status);
      }
      return text;
    },
  };
}
