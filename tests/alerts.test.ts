import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readAlertConfig } from "../lib/server/env";
import { evaluateAlert, isAlertSession, trendVotesFullyMixed, type AlertInput } from "../lib/alerts/rules";
import { createMemoryStore, createRedisStore } from "../lib/alerts/store";
import { answerCallbackQuery, editMessageText, sendTelegramMessage, TELEGRAM_MAX_TEXT, TelegramError } from "../lib/alerts/telegram";
import { jsonResponse, scriptedFetch } from "./fakes";

// Fri 2026-10-16 10:05 UTC (London session) and Sat 2026-10-17 10:05 UTC.
const FRI = Date.UTC(2026, 9, 16, 10, 5);
const SAT = Date.UTC(2026, 9, 17, 10, 5);
const settings = { minConfidence: 60, cooldownHours: 3, sessionsOnly: false };

function input(overrides: Partial<Omit<AlertInput, "signal">> & { signal?: Partial<AlertInput["signal"]> } = {}): AlertInput {
  const { signal, ...rest } = overrides;
  return {
    mode: "day",
    signal: { bias: "BUY", confidence: 72, entry: 2400, smcVerdict: "agree", ...signal },
    atr: 6,
    now: FRI,
    last: null,
    settings,
    ...rest,
  };
}

describe("evaluateAlert", () => {
  test("a confident BUY with no prior alert is sent", () => {
    assert.deepEqual(evaluateAlert(input()), { send: true, reason: "ok" });
  });

  test("below the confidence threshold is skipped, at the threshold is sent", () => {
    assert.equal(evaluateAlert(input({ signal: { confidence: 59 } })).send, false);
    assert.equal(evaluateAlert(input({ signal: { confidence: 60 } })).send, true);
    assert.equal(evaluateAlert(input({ signal: { confidence: null } })).send, false);
  });

  test("NO_TRADE is skipped", () => {
    const d = evaluateAlert(input({ signal: { bias: "NO_TRADE", confidence: null, entry: null } }));
    assert.deepEqual(d, { send: false, reason: "no_trade" });
  });

  test("an SMC verdict of against is skipped; neutral and unavailable are allowed", () => {
    assert.deepEqual(evaluateAlert(input({ signal: { smcVerdict: "against" } })), { send: false, reason: "smc_against" });
    assert.equal(evaluateAlert(input({ signal: { smcVerdict: "neutral" } })).send, true);
    assert.equal(evaluateAlert(input({ signal: { smcVerdict: "unavailable" } })).send, true);
  });

  test("cooldown blocks a similar entry inside the window", () => {
    const last = { entry: 2402, at: FRI - 60 * 60_000, confidence: 70 };
    const d = evaluateAlert(input({ last }));
    assert.equal(d.send, false);
    assert.match(d.reason, /cooldown_day_BUY/);
  });

  test("an entry that moved more than 1 x ATR overrides the cooldown", () => {
    const last = { entry: 2390, at: FRI - 60 * 60_000, confidence: 70 };
    assert.deepEqual(evaluateAlert(input({ last })), { send: true, reason: "entry_moved_over_1_atr" });
    // exactly 1 x ATR is not "more than"
    assert.equal(evaluateAlert(input({ last: { ...last, entry: 2394 } })).send, false);
  });

  test("after the cooldown the same entry may alert again", () => {
    const last = { entry: 2400, at: FRI - 3 * 3_600_000 - 1, confidence: 70 };
    assert.equal(evaluateAlert(input({ last })).send, true);
  });

  test("session filter limits alerts to weekdays 07:00-20:00 UTC", () => {
    const only = { ...settings, sessionsOnly: true };
    assert.equal(evaluateAlert(input({ settings: only })).send, true);
    assert.deepEqual(evaluateAlert(input({ settings: only, now: SAT })), { send: false, reason: "outside_session" });
    assert.equal(evaluateAlert(input({ settings: only, now: Date.UTC(2026, 9, 16, 6, 59) })).send, false);
    assert.equal(evaluateAlert(input({ settings: only, now: Date.UTC(2026, 9, 16, 7, 0) })).send, true);
    assert.equal(evaluateAlert(input({ settings: only, now: Date.UTC(2026, 9, 16, 19, 59) })).send, true);
    assert.equal(evaluateAlert(input({ settings: only, now: Date.UTC(2026, 9, 16, 20, 0) })).send, false);
    assert.equal(isAlertSession(SAT), false);
  });

  test("trend votes are fully mixed only when up and down are tied", () => {
    assert.equal(trendVotesFullyMixed({ up: 1, down: 1, range: 1 }), true);
    assert.equal(trendVotesFullyMixed({ up: 0, down: 0, range: 3 }), true);
    assert.equal(trendVotesFullyMixed({ up: 2, down: 1, range: 0 }), false);
    assert.equal(trendVotesFullyMixed({ up: 0, down: 2, range: 1 }), false);
  });
});

describe("sendTelegramMessage", () => {
  test("posts an HTML message to the bot API", async () => {
    const { fetchImpl, calls } = scriptedFetch([["api.telegram.org", () => jsonResponse({ ok: true })]]);
    await sendTelegramMessage({ token: "123:secret", chatId: "42", text: "hi <b>", fetchImpl });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.telegram.org/bot123:secret/sendMessage");
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    assert.deepEqual(body, { chat_id: "42", text: "hi <b>", parse_mode: "HTML", disable_web_page_preview: true });
  });

  test("errors never contain the token", async () => {
    const http = scriptedFetch([["api.telegram.org", () => jsonResponse({ ok: false }, 401)]]);
    await assert.rejects(
      sendTelegramMessage({ token: "123:secret", chatId: "42", text: "x", fetchImpl: http.fetchImpl }),
      (e: unknown) => e instanceof TelegramError && e.status === 401 && !e.message.includes("secret"),
    );
    const net = scriptedFetch([]); // unmatched URL: fetch fails with a TypeError
    await assert.rejects(
      sendTelegramMessage({ token: "123:secret", chatId: "42", text: "x", fetchImpl: net.fetchImpl }),
      (e: unknown) => e instanceof TelegramError && !e.message.includes("secret"),
    );
  });

  test("sends an inline keyboard and trims text to the 4096 limit", async () => {
    const { fetchImpl, calls } = scriptedFetch([["api.telegram.org", () => jsonResponse({ ok: true })]]);
    const keyboard = { inline_keyboard: [[{ text: "Calls", callback_data: "calls" }]] };
    await sendTelegramMessage({ token: "123:secret", chatId: "42", text: `${"line\n".repeat(2000)}end`, fetchImpl, replyMarkup: keyboard });
    const body = JSON.parse(String(calls[0].init?.body)) as { text: string; reply_markup: unknown };
    assert.ok(body.text.length <= TELEGRAM_MAX_TEXT);
    assert.deepEqual(body.reply_markup, keyboard);
  });

  test("editMessageText and answerCallbackQuery call the right methods", async () => {
    const { fetchImpl, calls } = scriptedFetch([["api.telegram.org", () => jsonResponse({ ok: true, result: true })]]);
    await editMessageText({ token: "123:secret", chatId: "42", messageId: 7, text: "new", fetchImpl });
    await answerCallbackQuery({ token: "123:secret", callbackQueryId: "cb1", fetchImpl });
    assert.match(calls[0].url, /\/editMessageText$/);
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { chat_id: "42", message_id: 7, text: "new", parse_mode: "HTML", disable_web_page_preview: true });
    assert.match(calls[1].url, /\/answerCallbackQuery$/);
    assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { callback_query_id: "cb1" });
  });

  test("keeps Telegram's description on the error for callers (not modified)", async () => {
    const { fetchImpl } = scriptedFetch([["api.telegram.org", () => jsonResponse({ ok: false, description: "Bad Request: message is not modified" }, 400)]]);
    await assert.rejects(
      editMessageText({ token: "123:secret", chatId: "42", messageId: 7, text: "same", fetchImpl }),
      (e: unknown) => e instanceof TelegramError && /not modified/.test(e.description ?? "") && !e.message.includes("secret"),
    );
  });

  test("times out on a hung request", async () => {
    const hung = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    await assert.rejects(
      sendTelegramMessage({ token: "t:t", chatId: "1", text: "x", fetchImpl: hung, timeoutMs: 20 }),
      (e: unknown) => e instanceof TelegramError && /in time/.test(e.message),
    );
  });
});

describe("readAlertConfig", () => {
  test("webhook secret and history page size are validated", () => {
    assert.equal(readAlertConfig({}).webhookSecret, null);
    assert.equal(readAlertConfig({}).historyPageSize, 5);
    const ok = readAlertConfig({ TELEGRAM_WEBHOOK_SECRET: "a-valid_secret-0123456789", CALLS_HISTORY_PAGE_SIZE: "8" });
    assert.equal(ok.webhookSecret, "a-valid_secret-0123456789");
    assert.equal(ok.historyPageSize, 8);
    assert.throws(() => readAlertConfig({ TELEGRAM_WEBHOOK_SECRET: "short" }), /TELEGRAM_WEBHOOK_SECRET/);
    assert.throws(() => readAlertConfig({ TELEGRAM_WEBHOOK_SECRET: "has spaces and !!! chars 123456" }), /TELEGRAM_WEBHOOK_SECRET/);
    assert.throws(() => readAlertConfig({ CALLS_HISTORY_PAGE_SIZE: "0" }), /CALLS_HISTORY_PAGE_SIZE/);
    assert.throws(() => readAlertConfig({ CALLS_HISTORY_PAGE_SIZE: "11" }), /CALLS_HISTORY_PAGE_SIZE/);
  });
});

describe("alert stores", () => {
  test("memory store: lock is exclusive and last alert round-trips", async () => {
    const store = createMemoryStore();
    assert.equal(await store.getLast("day", "BUY"), null);
    assert.equal(await store.acquireLock("day", "BUY", 120), true);
    assert.equal(await store.acquireLock("day", "BUY", 120), false);
    assert.equal(await store.acquireLock("day", "SELL", 120), true);
    await store.releaseLock("day", "BUY");
    assert.equal(await store.acquireLock("day", "BUY", 120), true);
    await store.saveLast("day", "BUY", { entry: 2400, at: 5, confidence: 70 }, 100);
    assert.deepEqual(await store.getLast("day", "BUY"), { entry: 2400, at: 5, confidence: 70 });
  });

  test("redis store sends REST commands with SET NX EX and bearer auth", async () => {
    const seen: unknown[] = [];
    const { fetchImpl, calls } = scriptedFetch([
      [
        "redis.example",
        (_url, init) => {
          const cmd = JSON.parse(String(init?.body)) as string[];
          seen.push(cmd);
          if (cmd[0] === "GET") return jsonResponse({ result: JSON.stringify({ entry: 2400, at: 9, confidence: 70 }) });
          if (cmd[0] === "SET" && cmd.includes("NX")) return jsonResponse({ result: seen.filter((c) => (c as string[]).includes("NX")).length === 1 ? "OK" : null });
          return jsonResponse({ result: "OK" });
        },
      ],
    ]);
    const store = createRedisStore({ url: "https://redis.example/", token: "tok-123", fetchImpl });
    assert.deepEqual(await store.getLast("swing", "SELL"), { entry: 2400, at: 9, confidence: 70 });
    assert.equal(await store.acquireLock("day", "BUY", 120), true);
    assert.equal(await store.acquireLock("day", "BUY", 120), false);
    await store.saveLast("day", "BUY", { entry: 1, at: 2, confidence: 3 }, 10_800);
    await store.releaseLock("day", "BUY");
    assert.deepEqual(seen[0], ["GET", "alert:last:swing:SELL"]);
    assert.deepEqual(seen[1], ["SET", "alert:lock:day:BUY", "1", "NX", "EX", 120]);
    assert.deepEqual(seen[3], ["SET", "alert:last:day:BUY", JSON.stringify({ entry: 1, at: 2, confidence: 3 }), "EX", 10_800]);
    assert.deepEqual(seen[4], ["DEL", "alert:lock:day:BUY"]);
    assert.equal(new Headers(calls[0].init?.headers).get("authorization"), "Bearer tok-123");
  });

  test("redis failures become StoreError without leaking the token", async () => {
    const { fetchImpl } = scriptedFetch([["redis.example", () => jsonResponse({ error: "boom" }, 500)]]);
    const store = createRedisStore({ url: "https://redis.example", token: "tok-123", fetchImpl });
    await assert.rejects(store.getLast("day", "BUY"), (e: unknown) => e instanceof Error && e.name === "StoreError" && !e.message.includes("tok-123"));
  });
});
