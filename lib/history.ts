/**
 * Signal history kept in the browser (localStorage). Pure functions only;
 * the React binding lives in historyStore.ts. Tested in tests/history.test.ts.
 */
import { round } from "./num";
import type { Mode, SignalResponse, SmcVerdict } from "./types";

export type TradeResult = "open" | "tp" | "sl" | "skipped";

export const RESULT_LABEL: Record<TradeResult, string> = {
  open: "Open",
  tp: "TP hit",
  sl: "SL hit",
  skipped: "Skipped",
};

export const RESULTS: readonly TradeResult[] = ["open", "tp", "sl", "skipped"];
export const HISTORY_KEY = "xauusd-signal:history:v1";
export const HISTORY_LIMIT = 200;

export interface HistoryEntry {
  id: string;
  /** ISO timestamp of the analysis. */
  createdAt: string;
  mode: Mode;
  bias: "BUY" | "SELL";
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  confidence: number | null;
  result: TradeResult;
  smcVerdict?: SmcVerdict;
  smcPenalties?: Array<{ code: string; penalty: number; message: string }>;
}

function isPrice(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function ordered(e: Pick<HistoryEntry, "bias" | "entry" | "stopLoss" | "takeProfit1">): boolean {
  return e.bias === "BUY"
    ? e.stopLoss < e.entry && e.entry < e.takeProfit1
    : e.stopLoss > e.entry && e.entry > e.takeProfit1;
}

/** Builds a history row from an API response; null for NO TRADE. */
export function entryFromResponse(res: SignalResponse, id: string): HistoryEntry | null {
  const s = res.signal;
  if (s.bias === "NO_TRADE") return null;
  if (!isPrice(s.entry) || !isPrice(s.stopLoss) || !isPrice(s.takeProfit1) || !isPrice(s.takeProfit2)) return null;
  const entry: HistoryEntry = {
    id,
    createdAt: res.snapshot.generatedAt,
    mode: res.snapshot.mode,
    bias: s.bias,
    entry: s.entry,
    stopLoss: s.stopLoss,
    takeProfit1: s.takeProfit1,
    takeProfit2: s.takeProfit2,
    confidence: s.confidence,
    result: "open",
    smcVerdict: s.smcVerdict ?? "unavailable",
    smcPenalties: s.smcPenalties ?? [],
  };
  return ordered(entry) ? entry : null;
}

function parseEntry(v: unknown): HistoryEntry | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || o.id.length === 0 || o.id.length > 64) return null;
  if (typeof o.createdAt !== "string" || !Number.isFinite(Date.parse(o.createdAt))) return null;
  if (o.mode !== "day" && o.mode !== "swing") return null;
  if (o.bias !== "BUY" && o.bias !== "SELL") return null;
  if (!isPrice(o.entry) || !isPrice(o.stopLoss) || !isPrice(o.takeProfit1) || !isPrice(o.takeProfit2)) return null;
  const result = RESULTS.includes(o.result as TradeResult) ? (o.result as TradeResult) : "open";
  const confidence =
    typeof o.confidence === "number" && Number.isFinite(o.confidence) ? Math.min(100, Math.max(0, o.confidence)) : null;
  const verdictRaw = typeof o.smcVerdict === "string" ? o.smcVerdict : "unavailable";
  const verdict: SmcVerdict = ["agree", "neutral", "against", "unavailable"].includes(verdictRaw) ? (verdictRaw as SmcVerdict) : "unavailable";
  const entry: HistoryEntry = {
    id: o.id,
    createdAt: o.createdAt,
    mode: o.mode,
    bias: o.bias,
    entry: o.entry,
    stopLoss: o.stopLoss,
    takeProfit1: o.takeProfit1,
    takeProfit2: o.takeProfit2,
    confidence,
    result,
    smcVerdict: verdict,
    smcPenalties: Array.isArray(o.smcPenalties) ? (o.smcPenalties as HistoryEntry["smcPenalties"]) : [],
  };
  return ordered(entry) ? entry : null;
}

/** Parses stored JSON, silently dropping anything malformed. */
export function parseHistory(raw: string | null): HistoryEntry[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const out: HistoryEntry[] = [];
  for (const item of data) {
    const e = parseEntry(item);
    if (e && !seen.has(e.id)) {
      seen.add(e.id);
      out.push(e);
    }
    if (out.length >= HISTORY_LIMIT) break;
  }
  return out;
}

export function serializeHistory(list: readonly HistoryEntry[]): string {
  return JSON.stringify(list);
}

/** Newest first, de-duplicated by id, capped at HISTORY_LIMIT. */
export function addEntry(list: readonly HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  return [entry, ...list.filter((e) => e.id !== entry.id)].slice(0, HISTORY_LIMIT);
}

export function setResult(list: readonly HistoryEntry[], id: string, result: TradeResult): HistoryEntry[] {
  return list.map((e) => (e.id === id ? { ...e, result } : e));
}

export function removeEntry(list: readonly HistoryEntry[], id: string): HistoryEntry[] {
  return list.filter((e) => e.id !== id);
}

/** Reward of TP1 in multiples of the stop distance. */
export function tp1R(e: HistoryEntry): number {
  const risk = Math.abs(e.entry - e.stopLoss);
  return risk > 0 ? Math.abs(e.takeProfit1 - e.entry) / risk : 0;
}

/** Realised R: TP hit counts as TP1 reached; SL hit is −1R; open/skipped have none. */
export function realizedR(e: HistoryEntry): number | null {
  if (e.result === "tp") return tp1R(e);
  if (e.result === "sl") return -1;
  return null;
}

export interface HistoryStats {
  total: number;
  open: number;
  skipped: number;
  wins: number;
  losses: number;
  closed: number;
  /** Percentage of closed trades that hit TP; null with no closed trades. */
  winRate: number | null;
  averageR: number | null;
  totalR: number;
}

export function historyStats(list: readonly HistoryEntry[]): HistoryStats {
  const count = (r: TradeResult) => list.filter((e) => e.result === r).length;
  const wins = count("tp");
  const losses = count("sl");
  const closed = wins + losses;
  const rs = list.map(realizedR).filter((r): r is number => r !== null);
  const totalR = rs.reduce((s, r) => s + r, 0);
  return {
    total: list.length,
    open: count("open"),
    skipped: count("skipped"),
    wins,
    losses,
    closed,
    winRate: closed > 0 ? round((wins / closed) * 100, 1) : null,
    averageR: closed > 0 ? round(totalR / closed, 2) : null,
    totalR: round(totalR, 2),
  };
}
