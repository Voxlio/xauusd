/**
 * Alert state in Redis (Upstash REST API, called through the injected fetch so tests stay offline).
 * Keys: alert:last:<mode>:<side> holds the last alerted entry; alert:lock:<mode>:<side> is a short SET NX lock
 * so two overlapping runs cannot both send.
 */
import type { FetchLike } from "../server/http";
import type { Mode } from "../types";
import type { LastAlert } from "./rules";

export type AlertSide = "BUY" | "SELL";

export interface AlertStore {
  getLast(mode: Mode, side: AlertSide): Promise<LastAlert | null>;
  /** Records the sent alert; it expires after `ttlSeconds` (the cooldown). */
  saveLast(mode: Mode, side: AlertSide, alert: LastAlert, ttlSeconds: number): Promise<void>;
  /** SET NX with a TTL. Returns false when another run already holds the lock. */
  acquireLock(mode: Mode, side: AlertSide, ttlSeconds: number): Promise<boolean>;
  releaseLock(mode: Mode, side: AlertSide): Promise<void>;
}

/** Long enough to cover one scan run (maxDuration 30 s), short enough not to block the next scan. */
export const LOCK_TTL_SECONDS = 120;

export const lastKey = (mode: Mode, side: AlertSide): string => `alert:last:${mode}:${side}`;
export const lockKey = (mode: Mode, side: AlertSide): string => `alert:lock:${mode}:${side}`;

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

function parseLast(raw: unknown): LastAlert | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Partial<LastAlert>;
    if (typeof v.entry === "number" && typeof v.at === "number" && typeof v.confidence === "number") {
      return { entry: v.entry, at: v.at, confidence: v.confidence };
    }
  } catch {
    /* fall through */
  }
  return null;
}

export interface RedisRestOptions {
  url: string;
  token: string;
  fetchImpl: FetchLike;
  timeoutMs?: number;
}

export function createRedisStore({ url, token, fetchImpl, timeoutMs = 4_000 }: RedisRestOptions): AlertStore {
  const endpoint = url.replace(/\/+$/, "");

  async function command(args: Array<string | number>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(args),
          signal: controller.signal,
          cache: "no-store",
        });
      } catch {
        throw new StoreError(controller.signal.aborted ? "Redis timed out" : "Redis could not be reached");
      }
      if (!response.ok) throw new StoreError(`Redis request failed (HTTP ${response.status})`);
      const body = (await response.json().catch(() => null)) as { result?: unknown; error?: unknown } | null;
      if (!body || body.error) throw new StoreError("Redis returned an error");
      return body.result ?? null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async getLast(mode, side) {
      return parseLast(await command(["GET", lastKey(mode, side)]));
    },
    async saveLast(mode, side, alert, ttlSeconds) {
      await command(["SET", lastKey(mode, side), JSON.stringify(alert), "EX", ttlSeconds]);
    },
    async acquireLock(mode, side, ttlSeconds) {
      return (await command(["SET", lockKey(mode, side), "1", "NX", "EX", ttlSeconds])) === "OK";
    },
    async releaseLock(mode, side) {
      await command(["DEL", lockKey(mode, side)]);
    },
  };
}

/** In-memory store for tests and local experiments. TTLs are ignored except for lock exclusivity. */
export function createMemoryStore(): AlertStore & { last: Map<string, LastAlert>; locks: Set<string> } {
  const last = new Map<string, LastAlert>();
  const locks = new Set<string>();
  return {
    last,
    locks,
    async getLast(mode, side) {
      return last.get(lastKey(mode, side)) ?? null;
    },
    async saveLast(mode, side, alert) {
      last.set(lastKey(mode, side), alert);
    },
    async acquireLock(mode, side) {
      const key = lockKey(mode, side);
      if (locks.has(key)) return false;
      locks.add(key);
      return true;
    },
    async releaseLock(mode, side) {
      locks.delete(lockKey(mode, side));
    },
  };
}
