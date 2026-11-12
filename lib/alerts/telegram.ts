/**
 * Telegram transport. The bot token is only ever used inside the request URL, never logged,
 * and errors carry no URL. Text is trimmed to Telegram's 4096-character limit.
 */
import type { FetchLike } from "../server/http";

export const TELEGRAM_TIMEOUT_MS = 8_000;
export const TELEGRAM_MAX_TEXT = 4096;

/** Messages never contain the token or the URL. */
export class TelegramError extends Error {
  readonly status: number | null;
  /** Telegram's own description (e.g. "message is not modified"), safe to log. */
  readonly description: string | null;
  constructor(message: string, status: number | null = null, description: string | null = null) {
    super(message);
    this.name = "TelegramError";
    this.status = status;
    this.description = description;
  }
}

export interface InlineButton {
  text: string;
  callback_data: string;
}
export interface InlineKeyboard {
  inline_keyboard: InlineButton[][];
}

/**
 * Cuts HTML text to `max` characters without leaving a half-written tag or entity:
 * whole lines are dropped from the end first (formatters keep tags balanced per line).
 */
export function trimTelegramText(text: string, max = TELEGRAM_MAX_TEXT): string {
  if (text.length <= max) return text;
  const suffix = "\n…";
  const lines = text.split("\n");
  let out = "";
  for (const line of lines) {
    const next = out === "" ? line : `${out}\n${line}`;
    if (next.length + suffix.length > max) break;
    out = next;
  }
  if (out === "") {
    // A single enormous line: drop tags, cut, and remove a trailing partial entity.
    out = text.replace(/<[^>]*>/g, "").slice(0, max - suffix.length).replace(/&[a-z#0-9]*$/i, "");
  }
  return `${out}${suffix}`;
}

interface TelegramBody {
  ok?: unknown;
  description?: unknown;
  result?: unknown;
}

interface CallOptions {
  token: string;
  fetchImpl: FetchLike;
  timeoutMs?: number;
}

async function callTelegram(method: string, payload: Record<string, unknown>, { token, fetchImpl, timeoutMs = TELEGRAM_TIMEOUT_MS }: CallOptions): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
        cache: "no-store",
      });
    } catch {
      // Network errors can carry the request URL (and so the token): report only the kind.
      throw new TelegramError(controller.signal.aborted ? "Telegram did not respond in time" : "Telegram could not be reached");
    }
    let body: TelegramBody | null = null;
    try {
      body = (await response.json()) as TelegramBody;
    } catch {
      body = null;
    }
    const description = body && typeof body.description === "string" ? body.description.slice(0, 200) : null;
    if (!response.ok) throw new TelegramError(`Telegram rejected the request (HTTP ${response.status})`, response.status, description);
    if (body && body.ok === false) throw new TelegramError("Telegram rejected the request", response.status, description);
    return body?.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

export interface SendTelegramOptions {
  token: string;
  chatId: string;
  text: string;
  fetchImpl: FetchLike;
  timeoutMs?: number;
  replyMarkup?: InlineKeyboard;
}

export type SendTelegram = (options: SendTelegramOptions) => Promise<void>;

/** sendMessage with parse_mode HTML and an optional inline keyboard. */
export const sendMessage: SendTelegram = async ({ token, chatId, text, fetchImpl, timeoutMs, replyMarkup }) => {
  await callTelegram(
    "sendMessage",
    {
      chat_id: chatId,
      text: trimTelegramText(text),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    },
    { token, fetchImpl, timeoutMs },
  );
};

/** Kept as the name the scan route and earlier tests use. */
export const sendTelegramMessage: SendTelegram = sendMessage;

export interface EditTelegramOptions extends SendTelegramOptions {
  messageId: number;
}

export async function editMessageText({ token, chatId, messageId, text, fetchImpl, timeoutMs, replyMarkup }: EditTelegramOptions): Promise<void> {
  await callTelegram(
    "editMessageText",
    {
      chat_id: chatId,
      message_id: messageId,
      text: trimTelegramText(text),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    },
    { token, fetchImpl, timeoutMs },
  );
}

export async function answerCallbackQuery(options: { token: string; callbackQueryId: string; text?: string; fetchImpl: FetchLike; timeoutMs?: number }): Promise<void> {
  const { token, callbackQueryId, text, fetchImpl, timeoutMs } = options;
  await callTelegram("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text: text.slice(0, 190) } : {}) }, { token, fetchImpl, timeoutMs });
}

export async function setWebhook(options: { token: string; url: string; secretToken: string; fetchImpl: FetchLike }): Promise<void> {
  const { token, url, secretToken, fetchImpl } = options;
  await callTelegram("setWebhook", { url, secret_token: secretToken, allowed_updates: ["message", "callback_query"] }, { token, fetchImpl });
}

export interface BotCommand {
  command: string;
  description: string;
}

export async function setMyCommands(options: { token: string; commands: BotCommand[]; fetchImpl: FetchLike }): Promise<void> {
  const { token, commands, fetchImpl } = options;
  await callTelegram("setMyCommands", { commands }, { token, fetchImpl });
}

/** Bound Telegram calls for one bot and chat, injected into the webhook handler. */
export interface TelegramApi {
  send(text: string, replyMarkup?: InlineKeyboard): Promise<void>;
  edit(messageId: number, text: string, replyMarkup?: InlineKeyboard): Promise<void>;
  answer(callbackQueryId: string, text?: string): Promise<void>;
}

export function createTelegramApi(options: { token: string; chatId: string; fetchImpl: FetchLike }): TelegramApi {
  const { token, chatId, fetchImpl } = options;
  return {
    send: (text, replyMarkup) => sendMessage({ token, chatId, text, fetchImpl, replyMarkup }),
    edit: (messageId, text, replyMarkup) => editMessageText({ token, chatId, messageId, text, fetchImpl, replyMarkup }),
    answer: (callbackQueryId, text) => answerCallbackQuery({ token, callbackQueryId, text, fetchImpl }),
  };
}
