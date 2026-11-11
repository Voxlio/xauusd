/**
 * Turns the model's raw reply into a typed, but still untrusted, ModelSignal.
 * Numbers here are NOT validated against risk rules; see validate.ts.
 */
import type { Bias } from "../types";

export interface ModelSignal {
  bias: Bias;
  confidence: number | null;
  entry: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  technicalReasons: string[];
  fundamentalReasons: string[];
  invalidation: string;
  newsWarning: string | null;
}

export class ModelOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelOutputError";
  }
}

/** Returns the balanced {...} block starting at `start`, respecting JSON strings. */
function objectSliceAt(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Balanced {...} blocks in order of their opening brace (bounded to keep it cheap). */
function objectSlices(text: string, maxStarts = 25): string[] {
  const slices: string[] = [];
  let from = 0;
  for (let n = 0; n < maxStarts; n++) {
    const start = text.indexOf("{", from);
    if (start === -1) break;
    const slice = objectSliceAt(text, start);
    if (slice) slices.push(slice);
    from = start + 1;
  }
  return slices;
}

/** Accepts bare JSON, fenced JSON, or JSON surrounded by stray text. */
export function extractJsonObject(text: string): Record<string, unknown> {
  const cleaned = text.replace(/^﻿/, "").trim();
  const candidates = [cleaned];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(cleaned);
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(...objectSlices(cleaned));

  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // try the next candidate
    }
  }
  throw new ModelOutputError("The AI reply did not contain a valid JSON object.");
}

const BIAS_ALIASES: Record<string, Bias> = {
  BUY: "BUY",
  LONG: "BUY",
  SELL: "SELL",
  SHORT: "SELL",
  NO_TRADE: "NO_TRADE",
  NOTRADE: "NO_TRADE",
  NONE: "NO_TRADE",
  NEUTRAL: "NO_TRADE",
  HOLD: "NO_TRADE",
  WAIT: "NO_TRADE",
  FLAT: "NO_TRADE",
};

export function parseBias(value: unknown): Bias {
  if (typeof value !== "string") throw new ModelOutputError("The AI reply has no bias.");
  const key = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
  const bias = BIAS_ALIASES[key];
  if (!bias) throw new ModelOutputError(`The AI reply has an unknown bias "${value.slice(0, 20)}".`);
  return bias;
}

/** Number, numeric string ("2,412.50", "$2412") or null. Anything else becomes null. */
export function parsePrice(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[,$\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function parseConfidence(value: unknown): number | null {
  const n = parsePrice(typeof value === "string" ? value.replace(/%$/, "") : value);
  if (n === null) return null;
  const scaled = n > 0 && n < 1 ? n * 100 : n;
  return Math.min(100, Math.max(0, Math.round(scaled)));
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

export function parseModelSignal(text: string): ModelSignal {
  const obj = extractJsonObject(text);
  const newsWarning = obj.newsWarning;
  return {
    bias: parseBias(obj.bias),
    confidence: parseConfidence(obj.confidence),
    entry: parsePrice(obj.entry),
    stopLoss: parsePrice(obj.stopLoss),
    takeProfit1: parsePrice(obj.takeProfit1),
    takeProfit2: parsePrice(obj.takeProfit2),
    technicalReasons: stringList(obj.technicalReasons),
    fundamentalReasons: stringList(obj.fundamentalReasons),
    invalidation: typeof obj.invalidation === "string" ? obj.invalidation : "",
    newsWarning: typeof newsWarning === "string" && newsWarning.trim() !== "" ? newsWarning : null,
  };
}
