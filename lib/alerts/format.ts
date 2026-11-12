/** Gamified Telegram messages (HTML parse mode). Pure: every dynamic string goes through escapeHtml. */
import { formatCountdown, formatUtc } from "../time";
import type { ValidatedSignal } from "../types";
import { plannedR } from "../calls/tracker";
import { computeStats, rankFor, type CallStats } from "../calls/stats";
import type { Call, CallEvent } from "../calls/types";
import type { InlineKeyboard } from "./telegram";

export const DISCLAIMER_LINE = "Demo account only. Not financial advice.";

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function price(n: number | null | undefined): string {
  return n === null || n === undefined ? "n/a" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** "▰▰▰▱▱" with `total` cells; fraction is 0..1. */
export function bar(fraction: number, total = 5): string {
  const filled = Math.max(0, Math.min(total, Math.round(fraction * total)));
  return "▰".repeat(filled) + "▱".repeat(total - filled);
}

/** Confidence 0-100 as a 5-cell meter. */
export function confidenceMeter(confidence: number | null): string {
  return bar((confidence ?? 0) / 100, 5);
}

export function formatR(r: number): string {
  const rounded = Math.round(r * 100) / 100;
  return `${rounded > 0 ? "+" : rounded < 0 ? "−" : ""}${Math.abs(rounded)}R`;
}

/** "1h 25m" / "40m" between two epoch times. */
export function formatElapsed(fromMs: number, toMs: number): string {
  return formatCountdown(Math.max(60_000, toMs - fromMs));
}

const sideEmoji = (side: string): string => (side === "BUY" ? "🟢" : "🔴");
const modeName = (mode: string): string => (mode === "day" ? "Day" : "Swing");

/** Progress along entry -> TP2, 0..1, from what the call has reached so far. */
export function progressFraction(call: Call): number {
  if (call.status === "TP2_HIT") return 1;
  if (call.tp1At !== undefined || call.status === "TP1_HIT") {
    const total = Math.abs(call.tp2 - call.entry);
    return total === 0 ? 0 : Math.abs(call.tp1 - call.entry) / total;
  }
  return 0;
}

function progressLine(call: Call): string {
  const f = progressFraction(call);
  return `${bar(f, 10)} ${Math.round(f * 100)}% to TP2`;
}

/** "✅ Entry ▫️ ⬜ TP1 ▫️ ⬜ TP2" */
export function ladder(call: Pick<Call, "status" | "enteredAt" | "tp1At">): string {
  const entered = call.enteredAt !== undefined;
  const tp1 = call.tp1At !== undefined;
  const tp2 = call.status === "TP2_HIT";
  const mark = (done: boolean) => (done ? "✅" : "⬜");
  return `${mark(entered)} Entry ▫️ ${mark(tp1)} TP1 ▫️ ${mark(tp2)} TP2`;
}

export function navKeyboard(): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: "📋 Calls", callback_data: "calls" },
        { text: "🗂 History", callback_data: "h:0" },
        { text: "📊 Stats", callback_data: "stats" },
      ],
    ],
  };
}

export function historyKeyboard(page: number, totalPages: number): InlineKeyboard {
  const row = [];
  if (page > 0) row.push({ text: "⬅️ Prev", callback_data: `h:${page - 1}` });
  if (page + 1 < totalPages) row.push({ text: "Next ➡️", callback_data: `h:${page + 1}` });
  return { inline_keyboard: row.length > 0 ? [row, ...navKeyboard().inline_keyboard] : navKeyboard().inline_keyboard };
}

/** New alert for a freshly created call. */
export function formatNewCallMessage(call: Call, signal: Pick<ValidatedSignal, "technicalReasons" | "invalidation" | "newsWarning" | "entryType">): string {
  const lines: string[] = [];
  lines.push(`${sideEmoji(call.side)} <b>NEW CALL: XAU/USD ${escapeHtml(call.side)}</b> (${modeName(call.mode)}) <code>#${escapeHtml(call.id)}</code>`);
  lines.push(`Confidence ${confidenceMeter(call.confidence)} ${call.confidence}/100 · SMC: ${escapeHtml(call.smcVerdict)}`);
  lines.push("");
  lines.push(`Entry${signal.entryType ? ` (${escapeHtml(signal.entryType)})` : ""}: <b>${price(call.entry)}</b>`);
  lines.push(`🛑 Stop loss: ${price(call.stopLoss)} (−1R)`);
  lines.push(`🥇 TP1: ${price(call.tp1)} (${formatR(plannedR(call, call.tp1))})`);
  lines.push(`🏆 TP2: ${price(call.tp2)} (${formatR(plannedR(call, call.tp2))})`);
  lines.push("");
  lines.push(ladder(call));

  const reasons = signal.technicalReasons.slice(0, 3);
  if (reasons.length > 0) {
    lines.push("", "<b>Why</b>");
    for (const r of reasons) lines.push(`- ${escapeHtml(clip(r, 220))}`);
  }
  if (signal.invalidation) lines.push("", `<b>Invalidation:</b> ${escapeHtml(clip(signal.invalidation, 300))}`);
  if (signal.newsWarning) lines.push("", `<b>News:</b> ${escapeHtml(clip(signal.newsWarning, 300))}`);

  lines.push("", `⏳ Entry valid until ${escapeHtml(formatUtc(call.validUntil))}`);
  lines.push(`<i>${DISCLAIMER_LINE}</i>`);
  return lines.join("\n");
}

export function scoreboardLine(stats: CallStats): string {
  const rank = rankFor(stats);
  if (stats.closed === 0) return `📊 No closed trades yet · ${rank.emoji} ${rank.name}`;
  const streak =
    stats.currentStreak.type === "none" ? "" : ` · ${stats.currentStreak.type === "win" ? "🔥" : "🧊"} ${stats.currentStreak.length} ${stats.currentStreak.type} streak`;
  return `📊 Win rate ${stats.winRate}% · Total ${formatR(stats.totalR)}${streak} · ${rank.emoji} ${escapeHtml(rank.name)}`;
}

const EVENT_HEAD: Record<CallEvent["type"], string> = {
  ENTRY: "🎯 <b>Entry hit</b>",
  TP1: "✅ <b>TP1 secured</b>",
  TP2: "🏆 <b>TP2 smashed</b>",
  SL: "🛑 <b>SL hit</b>",
  EXPIRED: "⌛ <b>Expired</b>",
};

/**
 * Message for one lifecycle event. `call` is the call right after the event.
 * `stats` (computed including this call) is appended when the call closed.
 */
export function formatEventMessage(call: Call, event: CallEvent, stats: CallStats | null): string {
  const lines: string[] = [];
  const head = EVENT_HEAD[event.type];
  const result =
    event.type === "TP1" ? ` ${formatR(plannedR(call, call.tp1))}` : event.type === "TP2" ? ` ${formatR(call.resultR ?? plannedR(call, call.tp2))}` : event.type === "SL" ? ` ${formatR(call.resultR ?? -1)}` : "";
  lines.push(`${head}${result}`);
  lines.push(`${sideEmoji(call.side)} XAU/USD ${escapeHtml(call.side)} (${modeName(call.mode)}) <code>#${escapeHtml(call.id)}</code>`);
  lines.push("");

  if (event.type === "ENTRY") lines.push(`Price touched ${price(call.entry)}. The trade is live.`);
  if (event.type === "TP1") lines.push(`Price reached ${price(call.tp1)}. The stop stays at ${price(call.stopLoss)}; TP2 is next at ${price(call.tp2)}.`);
  if (event.type === "TP2") lines.push(`Price reached ${price(call.tp2)}. Full target done.`);
  if (event.type === "SL") {
    lines.push(`Price reached ${price(call.stopLoss)}.${call.tp1At !== undefined ? " TP1 had been reached first, but the stop was not moved, so this closes at −1R." : ""}`);
    lines.push("Losses are part of the game. Risk small, stay consistent.");
  }
  if (event.type === "EXPIRED") {
    lines.push(
      call.closedAt !== undefined && call.closedAt < call.validUntil
        ? `Price hit the stop level ${price(call.stopLoss)} before entry, so the setup is void. No trade was taken.`
        : `Price never reached ${price(call.entry)} before ${escapeHtml(formatUtc(call.validUntil))}. The call was cancelled.`,
    );
  }

  lines.push("");
  lines.push(progressLine(call));
  lines.push(ladder(call));
  lines.push(`⏱ ${escapeHtml(formatElapsed(call.createdAt, event.at))} since the call`);
  if (stats && (event.type === "TP2" || event.type === "SL" || event.type === "EXPIRED")) lines.push("", scoreboardLine(stats));
  return lines.join("\n");
}

const STATUS_LABEL: Record<Call["status"], string> = {
  PENDING: "⏳ Waiting for entry",
  ACTIVE: "🎯 Active",
  TP1_HIT: "✅ TP1 secured",
  TP2_HIT: "🏆 TP2",
  SL_HIT: "🛑 SL",
  EXPIRED: "⌛ Expired",
};

export function formatOpenCalls(calls: readonly Call[]): string {
  if (calls.length === 0) return "📋 <b>Open calls</b>\n\nNo open calls right now. The next one will show up here.";
  const lines = ["📋 <b>Open calls</b>"];
  for (const c of calls) {
    lines.push("");
    lines.push(`${sideEmoji(c.side)} <b>${escapeHtml(c.side)}</b> (${modeName(c.mode)}) <code>#${escapeHtml(c.id)}</code> · ${STATUS_LABEL[c.status]}`);
    lines.push(`Entry ${price(c.entry)} · SL ${price(c.stopLoss)} · TP1 ${price(c.tp1)} · TP2 ${price(c.tp2)}`);
    lines.push(`${progressLine(c)}`);
    lines.push(ladder(c));
    if (c.status === "PENDING") lines.push(`Entry valid until ${escapeHtml(formatUtc(c.validUntil))}`);
  }
  return lines.join("\n");
}

function outcomeLabel(c: Call): string {
  if (c.status === "TP2_HIT") return "🏆 TP2";
  if (c.status === "SL_HIT") return c.tp1At !== undefined ? "🛑 SL after TP1" : "🛑 SL";
  return "⌛ Expired";
}

export function formatHistoryPage(calls: readonly Call[], page: number, totalPages: number, total: number): string {
  if (total === 0) return "🗂 <b>History</b>\n\nNo closed calls yet.";
  const lines = [`🗂 <b>History</b> · page ${page + 1}/${totalPages}`];
  for (const c of calls) {
    const r = c.resultR === undefined ? "no entry" : formatR(c.resultR);
    lines.push("");
    lines.push(`${sideEmoji(c.side)} ${escapeHtml(c.side)} (${modeName(c.mode)}) <code>#${escapeHtml(c.id)}</code>`);
    lines.push(`${outcomeLabel(c)} · <b>${r}</b> · ${escapeHtml(formatUtc(c.closedAt ?? c.createdAt))}`);
  }
  return lines.join("\n");
}

export function formatStats(calls: readonly Call[]): string {
  const stats = computeStats(calls);
  const rank = rankFor(stats);
  const lines = [`📊 <b>Scoreboard</b>`, `${rank.emoji} Rank: <b>${escapeHtml(rank.name)}</b>`, ""];
  if (stats.closed === 0) {
    lines.push("No closed trades yet. Your first result will start the scoreboard.");
    if (stats.expired > 0) lines.push(`Expired (never entered): ${stats.expired}`);
    return lines.join("\n");
  }
  lines.push(`Win rate: <b>${stats.winRate}%</b> (${stats.wins}W / ${stats.losses}L, a win = TP1 or TP2 reached)`);
  lines.push(`Total: <b>${formatR(stats.totalR)}</b> · Average: ${formatR(stats.avgR ?? 0)} per trade`);
  lines.push(`Streak: ${stats.currentStreak.type === "none" ? "none" : `${stats.currentStreak.length} ${stats.currentStreak.type}${stats.currentStreak.length > 1 ? "s" : ""} in a row`} · Best win streak: ${stats.bestWinStreak}`);
  lines.push(`TP2 hits: ${stats.tp2Count} · Expired: ${stats.expired}`);
  lines.push(`By mode: Day ${stats.byMode.day} · Swing ${stats.byMode.swing}`);
  if (stats.best) lines.push(`Best: <code>#${escapeHtml(stats.best.id)}</code> ${formatR(stats.best.resultR ?? 0)}`);
  if (stats.worst) lines.push(`Worst: <code>#${escapeHtml(stats.worst.id)}</code> ${formatR(stats.worst.resultR ?? 0)}`);
  lines.push("", `<i>${DISCLAIMER_LINE}</i>`);
  return lines.join("\n");
}

export function formatHelp(): string {
  return [
    "🥇 <b>XAU/USD call tracker</b>",
    "",
    "I alert you to trade ideas and follow each one: entry, TP1, TP2 or stop.",
    "",
    "/calls · open calls and progress",
    "/history · past calls, 5 per page",
    "/stats · scoreboard and rank",
    "/help · this message",
    "",
    `<i>${DISCLAIMER_LINE}</i>`,
  ].join("\n");
}
