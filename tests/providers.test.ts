import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildAnthropicBody, extractAnthropicText } from "../lib/ai/anthropic";
import { extractOpenAIText } from "../lib/ai/openai";
import { AIError, createProvider } from "../lib/ai/provider";
import { buildUserPayload, buildUserPrompt, SYSTEM_PROMPT } from "../lib/ai/prompt";
import { readConfig } from "../lib/server/env";
import { AppError } from "../lib/server/errors";
import { buildTechnicals } from "../lib/technicals";
import { summarizeCalendar, summarizeMacro } from "../lib/fundamentals";
import { TIMEFRAME_MS } from "../lib/config";
import { candlesFromCloses, wave } from "./helpers";
import { hangingRoute, jsonResponse, scriptedFetch, testConfig } from "./fakes";

const baseEnv = { TWELVE_DATA_API_KEY: "td", ANTHROPIC_API_KEY: "sk-ant" };

describe("readConfig", () => {
  test("defaults to Anthropic with the default model, thinking off and a 60 s cache", () => {
    const c = readConfig(baseEnv);
    assert.equal(c.ai.provider, "anthropic");
    assert.equal(c.ai.model, "claude-haiku-5-5");
    assert.equal(c.ai.thinking, "off");
    assert.equal(c.cacheTtlMs, 60_000);
    assert.equal(c.fredKey, null);
    assert.equal(c.calendarFallback, "forexfactory");
  });

  test("switches provider and model from env", () => {
    const c = readConfig({ ...baseEnv, AI_PROVIDER: "OpenAI", AI_MODEL: "gpt-4.1", OPENAI_API_KEY: "sk-oa" });
    assert.equal(c.ai.provider, "openai");
    assert.equal(c.ai.model, "gpt-4.1");
    assert.equal(c.ai.apiKey, "sk-oa");
  });

  test("missing keys produce a config error with a hint", () => {
    assert.throws(
      () => readConfig({ ANTHROPIC_API_KEY: "x" }),
      (e: unknown) => e instanceof AppError && e.code === "CONFIG_MISSING" && /TWELVE_DATA_API_KEY/.test(e.message) && !!e.hint,
    );
    assert.throws(() => readConfig({ TWELVE_DATA_API_KEY: "td" }), /ANTHROPIC_API_KEY/);
    assert.throws(() => readConfig({ ...baseEnv, AI_PROVIDER: "openai" }), /OPENAI_API_KEY/);
  });

  test("rejects invalid values", () => {
    assert.throws(() => readConfig({ ...baseEnv, AI_PROVIDER: "llama" }), /AI_PROVIDER/);
    assert.throws(() => readConfig({ ...baseEnv, CACHE_TTL_SECONDS: "abc" }), /CACHE_TTL_SECONDS/);
    assert.throws(() => readConfig({ ...baseEnv, AI_BASE_URL: "http://evil.example" }), /https/);
    assert.throws(() => readConfig({ ...baseEnv, AI_MODEL: "model with spaces" }), /AI_MODEL/);
    assert.throws(() => readConfig({ ...baseEnv, AI_THINKING: "max" }), /AI_THINKING/);
    assert.throws(() => readConfig({ ...baseEnv, NEWS_GATE: "off" }), /NEWS_GATE/);
    assert.throws(() => readConfig({ ...baseEnv, CACHE_TTL_SECONDS: "600" }), /CACHE_TTL_SECONDS/);
  });

  test("news gate defaults to strict", () => {
    assert.equal(readConfig(baseEnv).newsGate, "strict");
    assert.equal(readConfig({ ...baseEnv, NEWS_GATE: "WARN" }).newsGate, "warn");
  });

  test("blank values count as unset", () => {
    const c = readConfig({ ...baseEnv, AI_MODEL: "  ", FRED_API_KEY: "" });
    assert.equal(c.ai.model, "claude-haiku-5-5");
    assert.equal(c.fredKey, null);
  });
});

describe("Anthropic provider", () => {
  test("sends the Messages API request with thinking disabled and returns text blocks only", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      [
        "api.anthropic.com/v1/messages",
        () =>
          jsonResponse({
            content: [
              { type: "thinking", thinking: "", signature: "x" },
              { type: "text", text: '{"bias":"NO_TRADE"}' },
            ],
            stop_reason: "end_turn",
          }),
      ],
    ]);
    const provider = createProvider(testConfig().ai, fetchImpl);
    const text = await provider.complete({ system: "sys", user: "hi", maxTokens: 500, timeoutMs: 1000 });
    assert.equal(text, '{"bias":"NO_TRADE"}');

    const init = calls[0].init;
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers["x-api-key"], "sk-ant-test");
    assert.equal(headers["anthropic-version"], "2023-06-01");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "claude-haiku-5-5");
    assert.equal(body.max_tokens, 500);
    assert.equal(body.system, "sys");
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
    assert.equal("temperature" in body, false);
  });

  test("AI_THINKING=auto omits the thinking param and adds token headroom", () => {
    const body = buildAnthropicBody({ ...testConfig().ai, thinking: "auto" }, "s", "u", 1000);
    assert.equal("thinking" in body, false);
    assert.ok(body.max_tokens > 1000);
  });

  test("maps HTTP errors to typed AIErrors with hints", async () => {
    const cases: Array<[number, string, RegExp]> = [
      [401, "auth", /ANTHROPIC_API_KEY/],
      [404, "model_not_found", /AI_MODEL/],
      [429, "rate_limit", /429/],
      [529, "overloaded", /529/],
    ];
    for (const [status, kind, pattern] of cases) {
      const { fetchImpl } = scriptedFetch([
        ["anthropic.com", () => jsonResponse({ type: "error", error: { type: "x", message: "nope" } }, status)],
      ]);
      const provider = createProvider(testConfig().ai, fetchImpl);
      await assert.rejects(
        provider.complete({ system: "s", user: "u", maxTokens: 10, timeoutMs: 500 }),
        (e: unknown) => e instanceof AIError && e.kind === kind && pattern.test(e.message),
      );
    }
  });

  test("times out", async () => {
    const { fetchImpl } = scriptedFetch([["anthropic.com", hangingRoute]]);
    const provider = createProvider(testConfig().ai, fetchImpl);
    await assert.rejects(
      provider.complete({ system: "s", user: "u", maxTokens: 10, timeoutMs: 50 }),
      (e: unknown) => e instanceof AIError && e.kind === "timeout",
    );
  });

  test("empty content is an error", async () => {
    const { fetchImpl } = scriptedFetch([["anthropic.com", () => jsonResponse({ content: [], stop_reason: "max_tokens" })]]);
    const provider = createProvider(testConfig().ai, fetchImpl);
    await assert.rejects(
      provider.complete({ system: "s", user: "u", maxTokens: 10, timeoutMs: 500 }),
      (e: unknown) => e instanceof AIError && e.kind === "empty" && /max_tokens/.test(e.message),
    );
  });

  test("extractAnthropicText tolerates odd payloads", () => {
    assert.equal(extractAnthropicText(null), "");
    assert.equal(extractAnthropicText({ content: "x" }), "");
  });
});

describe("OpenAI-compatible provider", () => {
  test("uses chat completions with JSON mode and a custom base URL", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      ["api.groq.example/openai/v1/chat/completions", () => jsonResponse({ choices: [{ message: { content: ' {"a":1} ' } }] })],
    ]);
    const provider = createProvider(
      { provider: "openai", model: "llama-x", apiKey: "sk-oa", baseUrl: "https://api.groq.example/openai/v1", thinking: "off" },
      fetchImpl,
    );
    assert.equal(provider.name, "openai");
    const text = await provider.complete({ system: "s", user: "u", maxTokens: 300, timeoutMs: 500 });
    assert.equal(text, '{"a":1}');
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer sk-oa");
    const body = JSON.parse(String(calls[0].init?.body));
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.max_completion_tokens, 300);
  });

  test("extractOpenAIText tolerates odd payloads", () => {
    assert.equal(extractOpenAIText({ choices: [] }), "");
    assert.equal(extractOpenAIText({ choices: [{ message: { content: null } }] }), "");
  });
});

describe("prompt", () => {
  const now = Date.UTC(2026, 9, 16, 10);
  const { summary } = buildTechnicals("day", {
    M15: candlesFromCloses(wave(300, 2400, 0.2, 3), TIMEFRAME_MS.M15, 0.8),
    H1: candlesFromCloses(wave(300, 2350, 1, 8), TIMEFRAME_MS.H1, 2),
    H4: candlesFromCloses(wave(300, 2200, 3, 20), TIMEFRAME_MS.H4, 5),
  });
  const macro = summarizeMacro(null, null);
  const calendar = summarizeCalendar([], now, "forexfactory", null);

  test("contains the risk frame and no raw candles", () => {
    const payload = buildUserPayload(summary, macro, calendar, now);
    assert.equal(payload.price, summary.price);
    assert.ok(payload.riskFrame.entryRange.low < summary.price && payload.riskFrame.entryRange.high > summary.price);
    const text = buildUserPrompt(summary, macro, calendar, now);
    assert.ok(!text.includes('"open"'), "raw OHLC must not be sent");
    assert.ok(text.length < 12_000, `prompt too large: ${text.length} chars`);
  });

  test("buy frame stop range sits below price and respects the ATR rules", () => {
    const buy = buildUserPayload(summary, macro, calendar, now).riskFrame.buy;
    if (!buy.feasible || !("stopLossRange" in buy) || !buy.stopLossRange) {
      assert.fail("expected a feasible buy frame for this fixture");
    }
    const { closest, farthest } = buy.stopLossRange;
    assert.ok(farthest < closest && closest < summary.price);
    assert.ok(summary.price - closest >= summary.atr * 0.99);
    assert.ok(summary.price - farthest <= summary.atr * 2.51);
  });

  test("system prompt demands JSON only with every required key", () => {
    for (const key of [
      "bias",
      "confidence",
      "entry",
      "stopLoss",
      "takeProfit1",
      "takeProfit2",
      "technicalReasons",
      "fundamentalReasons",
      "invalidation",
      "newsWarning",
    ]) {
      assert.ok(SYSTEM_PROMPT.includes(`"${key}"`), key);
    }
    assert.match(SYSTEM_PROMPT, /ONLY one JSON object/);
  });
});
