/** Telegram sender and message formatter. The bot token is only ever used inside the request URL, never logged. */
import type { FetchLike } from "../server/http";
import { formatUtc } from "../time";
import type { Mode, ValidatedSignal } from "../types";
import { VALID_FOR_MS } from "./rules";

export const TELEGRAM_TIMEOUT_MS = 8_000;

/** Messages never contain the token or the URL. */
export class TelegramError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "TelegramError";
    this.status = status;
  }
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function price(n: number | null): string {
  return n === null ? "n/a" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function formatAlertMessage(signal: ValidatedSignal, mode: Mode, now: number): string {
  const lines: string[] = [];
  lines.push(`<b>XAU/USD ${escapeHtml(signal.bias)} (${mode === "day" ? "Day" : "Swing"})</b>`);
  lines.push(`Entry${signal.entryType ? ` (${escapeHtml(signal.entryType)})` : ""}: <b>${price(signal.entry)}</b>`);
  lines.push(`Stop loss: ${price(signal.stopLoss)}`);
  const r1 = signal.riskReward1 === null ? "" : ` (${signal.riskReward1}R)`;
  const r2 = signal.riskReward2 === null ? "" : ` (${signal.riskReward2}R)`;
  lines.push(`TP1: ${price(signal.takeProfit1)}${r1}`);
  lines.push(`TP2: ${price(signal.takeProfit2)}${r2}`);
  lines.push(`Confidence: ${signal.confidence ?? "n/a"}/100`);
  lines.push(`SMC: ${escapeHtml(signal.smcVerdict ?? "unavailable")}`);

  const reasons = signal.technicalReasons.slice(0, 3);
  if (reasons.length > 0) {
    lines.push("", "<b>Why</b>");
    for (const r of reasons) lines.push(`- ${escapeHtml(clip(r, 220))}`);
  }
  if (signal.invalidation) lines.push("", `<b>Invalidation:</b> ${escapeHtml(clip(signal.invalidation, 300))}`);
  if (signal.newsWarning) lines.push("", `<b>News:</b> ${escapeHtml(clip(signal.newsWarning, 300))}`);

  lines.push("", `Valid until ${escapeHtml(formatUtc(now + VALID_FOR_MS[mode]))}`);
  lines.push("<i>Demo account only. Not financial advice.</i>");
  return lines.join("\n");
}

export interface SendTelegramOptions {
  token: string;
  chatId: string;
  text: string;
  fetchImpl: FetchLike;
  timeoutMs?: number;
}

export type SendTelegram = (options: SendTelegramOptions) => Promise<void>;

export const sendTelegramMessage: SendTelegram = async ({ token, chatId, text, fetchImpl, timeoutMs = TELEGRAM_TIMEOUT_MS }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
        signal: controller.signal,
        cache: "no-store",
      });
    } catch {
      // Network errors can carry the request URL (and so the token): report only the kind.
      throw new TelegramError(controller.signal.aborted ? "Telegram did not respond in time" : "Telegram could not be reached");
    }
    if (!response.ok) throw new TelegramError(`Telegram rejected the message (HTTP ${response.status})`, response.status);
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      /* an unreadable body after a 2xx is treated as success below only if ok flag is absent */
    }
    if (body && typeof body === "object" && (body as { ok?: unknown }).ok === false) {
      throw new TelegramError("Telegram rejected the message", response.status);
    }
  } finally {
    clearTimeout(timer);
  }
};
