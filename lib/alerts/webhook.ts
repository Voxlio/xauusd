/**
 * Framework-agnostic handler for POST /api/telegram/webhook (Request in, Response out).
 * Verifies Telegram's secret header, ignores every chat except TELEGRAM_CHAT_ID, answers commands and inline buttons.
 * All I/O is injected. app/api/telegram/webhook/route.ts delegates here.
 */
import { createRedisCallStore, type CallStore } from "../calls/store";
import { readAlertConfig, type AlertConfig, type Env } from "../server/env";
import type { FetchLike } from "../server/http";
import { formatHelp, formatHistoryPage, formatOpenCalls, formatStats, historyKeyboard, navKeyboard } from "./format";
import { redactSecrets, secretsMatch } from "./scan";
import { createTelegramApi, type InlineKeyboard, type TelegramApi } from "./telegram";

export interface WebhookDeps {
  env: Env;
  fetchImpl: FetchLike;
  createCallStore: (config: AlertConfig, fetchImpl: FetchLike) => CallStore | null;
  createTelegram: (options: { token: string; chatId: string; fetchImpl: FetchLike }) => TelegramApi;
}

const MAX_BODY_BYTES = 64 * 1024;

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
}

interface TelegramUpdate {
  message?: { text?: string; chat?: { id?: number | string } };
  callback_query?: { id?: string; data?: string; message?: { message_id?: number; chat?: { id?: number | string } } };
}

interface View {
  text: string;
  markup: InlineKeyboard;
}

async function buildView(kind: "calls" | "stats" | "help" | { history: number }, store: CallStore, pageSize: number): Promise<View> {
  if (kind === "help") return { text: formatHelp(), markup: navKeyboard() };
  if (kind === "calls") return { text: formatOpenCalls(await store.listOpen()), markup: navKeyboard() };
  if (kind === "stats") return { text: formatStats(await store.allClosed()), markup: navKeyboard() };
  const total = await store.countClosed();
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.max(0, Math.min(kind.history, totalPages - 1));
  const calls = await store.listClosed(page * pageSize, pageSize);
  return { text: formatHistoryPage(calls, page, totalPages, total), markup: historyKeyboard(page, totalPages) };
}

/** "/calls@MyBot extra" -> "/calls" */
function commandOf(text: string): string {
  return (text.trim().split(/\s+/)[0] ?? "").split("@")[0].toLowerCase();
}

function viewForCommand(command: string): Parameters<typeof buildView>[0] | null {
  if (command === "/start" || command === "/help") return "help";
  if (command === "/calls") return "calls";
  if (command === "/history") return { history: 0 };
  if (command === "/stats") return "stats";
  return null;
}

function viewForCallback(data: string): Parameters<typeof buildView>[0] | null {
  if (data === "calls") return "calls";
  if (data === "stats") return "stats";
  const m = /^h:(\d{1,4})$/.exec(data);
  return m ? { history: Number(m[1]) } : null;
}

export async function handleWebhookRequest(request: Request, overrides: Partial<WebhookDeps> = {}): Promise<Response> {
  const deps: WebhookDeps = {
    env: process.env,
    fetchImpl: fetch,
    createCallStore: (c, fetchImpl) => (c.redisUrl && c.redisToken ? createRedisCallStore({ url: c.redisUrl, token: c.redisToken, fetchImpl }) : null),
    createTelegram: createTelegramApi,
    ...overrides,
  };

  if (request.method !== "POST") {
    return json(405, { ok: false, error: "Use POST." }, { allow: "POST" });
  }

  // Fail closed: no configured secret means nobody is trusted.
  const secret = (deps.env.TELEGRAM_WEBHOOK_SECRET ?? "").trim();
  const provided = (request.headers.get("x-telegram-bot-api-secret-token") ?? "").trim();
  if (secret === "" || provided === "" || !secretsMatch(provided, secret)) {
    return json(401, { ok: false, error: "Unauthorized." });
  }

  let update: TelegramUpdate;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return json(413, { ok: false, error: "Too large." });
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return json(400, { ok: false, error: "Bad update." });
    update = parsed as TelegramUpdate;
  } catch {
    return json(400, { ok: false, error: "Bad update." });
  }

  // From here on every valid update gets a 200, so Telegram never retries endlessly.
  try {
    const alerts = readAlertConfig(deps.env);
    if (!alerts.telegramToken || !alerts.telegramChatId) return json(200, { ok: true, ignored: "not_configured" });

    const chatId = update.callback_query ? update.callback_query.message?.chat?.id : update.message?.chat?.id;
    if (chatId === undefined || String(chatId) !== alerts.telegramChatId) return json(200, { ok: true, ignored: "other_chat" });

    const telegram = deps.createTelegram({ token: alerts.telegramToken, chatId: alerts.telegramChatId, fetchImpl: deps.fetchImpl });
    const store = deps.createCallStore(alerts, deps.fetchImpl);

    if (update.callback_query) {
      const q = update.callback_query;
      if (q.id) await telegram.answer(q.id).catch(() => undefined);
      const kind = viewForCallback(q.data ?? "");
      if (!kind || !store || q.message?.message_id === undefined) return json(200, { ok: true });
      const view = await buildView(kind, store, alerts.historyPageSize);
      try {
        await telegram.edit(q.message.message_id, view.text, view.markup);
      } catch (error) {
        // Pressing the same button twice makes Telegram answer "message is not modified"; that is fine.
        const description = error instanceof Error && "description" in error ? String((error as { description: unknown }).description ?? "") : "";
        if (!/not modified/i.test(description)) throw error;
      }
      return json(200, { ok: true });
    }

    const text = update.message?.text;
    if (typeof text === "string" && text.startsWith("/")) {
      const kind = viewForCommand(commandOf(text));
      if (kind) {
        if (kind === "help") {
          await telegram.send(formatHelp(), navKeyboard());
        } else if (store) {
          const view = await buildView(kind, store, alerts.historyPageSize);
          await telegram.send(view.text, view.markup);
        } else {
          await telegram.send("Storage (Redis) is not configured, so there is nothing to show yet.", navKeyboard());
        }
      }
    }
    return json(200, { ok: true });
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    console.error(`[api/telegram/webhook] ${name}: ${error instanceof Error ? redactSecrets(error.message, deps.env) : "unknown"}`);
    return json(200, { ok: true, error: "handler_failed" });
  }
}
