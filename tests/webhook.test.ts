import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { handleWebhookRequest, type WebhookDeps } from "../lib/alerts/webhook";
import { TelegramError, type InlineKeyboard, type TelegramApi } from "../lib/alerts/telegram";
import { createMemoryCallStore, type CallStore } from "../lib/calls/store";
import type { Call } from "../lib/calls/types";
import { scriptedFetch } from "./fakes";

const SECRET = "webhook-secret-0123456789";
const ENV = {
  TELEGRAM_BOT_TOKEN: "123456:tg-secret-token",
  TELEGRAM_CHAT_ID: "42",
  TELEGRAM_WEBHOOK_SECRET: SECRET,
  KV_REST_API_URL: "https://redis.example",
  KV_REST_API_TOKEN: "redis-secret-token",
};
const T0 = Date.UTC(2026, 9, 16, 10, 5);

function call(id: string, over: Partial<Call> = {}): Call {
  return {
    id, mode: "day", side: "BUY", entry: 2400, stopLoss: 2390, tp1: 2415, tp2: 2425, confidence: 70, smcVerdict: "agree",
    createdAt: T0, validUntil: T0 + 1_800_000, status: "PENDING", lastCheckedAt: T0, ...over,
  };
}

interface Recorder {
  sent: Array<{ text: string; markup?: InlineKeyboard }>;
  edits: Array<{ messageId: number; text: string; markup?: InlineKeyboard }>;
  answers: string[];
}

function setup(opts: { store?: CallStore | null; editError?: Error } = {}) {
  const store = createMemoryCallStore();
  const rec: Recorder = { sent: [], edits: [], answers: [] };
  const telegram: TelegramApi = {
    send: async (text, markup) => void rec.sent.push({ text, markup }),
    edit: async (messageId, text, markup) => {
      if (opts.editError) throw opts.editError;
      rec.edits.push({ messageId, text, markup });
    },
    answer: async (id) => void rec.answers.push(id),
  };
  const deps: Partial<WebhookDeps> = {
    env: ENV,
    fetchImpl: scriptedFetch([]).fetchImpl,
    createCallStore: () => (opts.store === undefined ? store : opts.store),
    createTelegram: () => telegram,
  };
  return { deps, store, rec };
}

function post(update: unknown, headers: Record<string, string> = { "x-telegram-bot-api-secret-token": SECRET }): Request {
  return new Request("https://app.example/api/telegram/webhook", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(update) });
}
const message = (text: string, chatId: number | string = 42) => ({ update_id: 1, message: { message_id: 1, text, chat: { id: chatId } } });
const callback = (data: string, chatId: number | string = 42) => ({ update_id: 2, callback_query: { id: "cb1", data, message: { message_id: 77, chat: { id: chatId } } } });

async function closedCalls(store: CallStore, n: number) {
  for (let i = 0; i < n; i++) {
    await store.save(call(`C${i}`, { status: i % 2 === 0 ? "TP2_HIT" : "SL_HIT", enteredAt: T0, tp1At: i % 2 === 0 ? T0 : undefined, closedAt: T0 + (i + 1) * 1000, resultR: i % 2 === 0 ? 2.5 : -1 }));
  }
}

describe("POST /api/telegram/webhook", () => {
  test("405 on GET", async () => {
    const res = await handleWebhookRequest(new Request("https://app.example/api/telegram/webhook"), setup().deps);
    assert.equal(res.status, 405);
  });

  test("401 without the secret header, with a wrong one, and when the secret is not configured", async () => {
    const { deps, rec } = setup();
    assert.equal((await handleWebhookRequest(post(message("/calls"), {}), deps)).status, 401);
    assert.equal((await handleWebhookRequest(post(message("/calls"), { "x-telegram-bot-api-secret-token": "nope" }), deps)).status, 401);
    const unset = await handleWebhookRequest(post(message("/calls"), { "x-telegram-bot-api-secret-token": "" }), { ...deps, env: { ...ENV, TELEGRAM_WEBHOOK_SECRET: undefined } });
    assert.equal(unset.status, 401);
    const unset2 = await handleWebhookRequest(post(message("/calls")), { ...deps, env: { ...ENV, TELEGRAM_WEBHOOK_SECRET: undefined } });
    assert.equal(unset2.status, 401);
    assert.equal(rec.sent.length, 0);
  });

  test("400 for a body that is not a JSON object", async () => {
    const { deps } = setup();
    const bad = new Request("https://app.example/x", { method: "POST", headers: { "x-telegram-bot-api-secret-token": SECRET }, body: "not json" });
    assert.equal((await handleWebhookRequest(bad, deps)).status, 400);
  });

  test("updates from another chat are ignored with a 200", async () => {
    const { deps, rec } = setup();
    for (const update of [message("/calls", 999), callback("calls", 999), { update_id: 3 }]) {
      const res = await handleWebhookRequest(post(update), deps);
      assert.equal(res.status, 200);
    }
    assert.deepEqual([rec.sent.length, rec.edits.length, rec.answers.length], [0, 0, 0]);
  });

  test("/start and /help show the help with the button row", async () => {
    const { deps, rec } = setup();
    for (const cmd of ["/start", "/help", "/help@XauBot"]) await handleWebhookRequest(post(message(cmd)), deps);
    assert.equal(rec.sent.length, 3);
    assert.match(rec.sent[0].text, /call tracker/);
    assert.deepEqual(rec.sent[0].markup?.inline_keyboard[0].map((b) => b.text), ["📋 Calls", "🗂 History", "📊 Stats"]);
  });

  test("/calls lists open calls with status, levels and progress", async () => {
    const { deps, rec, store } = setup();
    await store.create(call("OPEN1"));
    await store.create(call("OPEN2", { status: "TP1_HIT", enteredAt: T0, tp1At: T0 }));
    await handleWebhookRequest(post(message("/calls")), deps);
    assert.match(rec.sent[0].text, /#OPEN1.*Waiting for entry/);
    assert.match(rec.sent[0].text, /#OPEN2.*TP1 secured/);
    assert.match(rec.sent[0].text, /Entry 2,400\.00 · SL 2,390\.00 · TP1 2,415\.00 · TP2 2,425\.00/);
    assert.match(rec.sent[0].text, /60% to TP2/);
  });

  test("/history shows 5 per page with a Next button; Prev and Next work through callbacks", async () => {
    const { deps, rec, store } = setup();
    await closedCalls(store, 7);
    await handleWebhookRequest(post(message("/history")), deps);
    const first = rec.sent[0];
    assert.match(first.text, /page 1\/2/);
    assert.equal((first.text.match(/<code>#C/g) ?? []).length, 5);
    assert.deepEqual(first.markup?.inline_keyboard[0].map((b) => b.callback_data), ["h:1"]);
    assert.match(first.text, /#C6/, "newest first");

    await handleWebhookRequest(post(callback("h:1")), deps);
    assert.deepEqual(rec.answers, ["cb1"]);
    assert.equal(rec.edits[0].messageId, 77);
    assert.match(rec.edits[0].text, /page 2\/2/);
    assert.equal((rec.edits[0].text.match(/<code>#C/g) ?? []).length, 2);
    assert.deepEqual(rec.edits[0].markup?.inline_keyboard[0].map((b) => b.callback_data), ["h:0"]);

    await handleWebhookRequest(post(callback("h:0")), deps);
    assert.match(rec.edits[1].text, /page 1\/2/);
  });

  test("the page size comes from CALLS_HISTORY_PAGE_SIZE and out-of-range pages are clamped", async () => {
    const { deps, rec, store } = setup();
    await closedCalls(store, 7);
    await handleWebhookRequest(post(callback("h:99")), { ...deps, env: { ...ENV, CALLS_HISTORY_PAGE_SIZE: "3" } });
    assert.match(rec.edits[0].text, /page 3\/3/);
  });

  test("/stats and the stats button show the scoreboard and rank", async () => {
    const { deps, rec, store } = setup();
    await closedCalls(store, 3);
    await handleWebhookRequest(post(message("/stats")), deps);
    assert.match(rec.sent[0].text, /Scoreboard/);
    assert.match(rec.sent[0].text, /Rank: <b>Rookie<\/b>/);
    assert.match(rec.sent[0].text, /Win rate: <b>66\.7%<\/b>/);
    await handleWebhookRequest(post(callback("stats")), deps);
    assert.match(rec.edits[0].text, /Scoreboard/);
    assert.deepEqual(rec.answers, ["cb1"]);
  });

  test("the Calls button edits the message in place", async () => {
    const { deps, rec, store } = setup();
    await store.create(call("OPEN1"));
    await handleWebhookRequest(post(callback("calls")), deps);
    assert.match(rec.edits[0].text, /#OPEN1/);
    assert.equal(rec.sent.length, 0);
  });

  test("empty states are friendly", async () => {
    const { deps, rec } = setup();
    for (const cmd of ["/calls", "/history", "/stats"]) await handleWebhookRequest(post(message(cmd)), deps);
    assert.match(rec.sent[0].text, /No open calls/);
    assert.match(rec.sent[1].text, /No closed calls yet/);
    assert.match(rec.sent[2].text, /No closed trades yet/);
  });

  test("unknown commands and plain text are ignored; unknown callback data is only acknowledged", async () => {
    const { deps, rec } = setup();
    await handleWebhookRequest(post(message("/nope")), deps);
    await handleWebhookRequest(post(message("hello")), deps);
    await handleWebhookRequest(post(callback("weird")), deps);
    assert.equal(rec.sent.length, 0);
    assert.equal(rec.edits.length, 0);
    assert.deepEqual(rec.answers, ["cb1"]);
  });

  test("pressing the same button twice (message is not modified) still returns 200", async () => {
    const err = new TelegramError("Telegram rejected the request (HTTP 400)", 400, "Bad Request: message is not modified");
    const { deps } = setup({ editError: err });
    const res = await handleWebhookRequest(post(callback("calls")), deps);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  test("any handler failure still answers 200 so Telegram does not retry, and leaks no secret", async () => {
    const broken: CallStore = { ...createMemoryCallStore(), listOpen: async () => { throw new Error(`boom ${ENV.TELEGRAM_BOT_TOKEN}`); } };
    const { deps } = setup({ store: broken });
    const res = await handleWebhookRequest(post(message("/calls")), deps);
    assert.equal(res.status, 200);
    const text = JSON.stringify(await res.json());
    assert.ok(!text.includes("tg-secret-token"));
  });

  test("without Redis the reply says so instead of failing", async () => {
    const { deps, rec } = setup({ store: null });
    await handleWebhookRequest(post(message("/calls")), deps);
    assert.match(rec.sent[0].text, /not configured/);
  });
});
