/**
 * Call storage. Redis layout (same REST client as lib/alerts/store.ts):
 *   calls:item:<id>   hash with the call fields
 *   calls:open        set of open call ids
 *   calls:closed      sorted set of closed call ids, scored by closedAt
 * Closed calls are kept for 90 days.
 */
import { createRedisClient, type RedisClient, type RedisRestOptions } from "../alerts/redis";
import { isTerminal, type Call, type CallStatus } from "./types";

export const CLOSED_TTL_SECONDS = 90 * 24 * 3600;
export const STATS_MAX_CALLS = 500;

export interface CallStore {
  /** Inserts a new call and marks it open. */
  create(call: Call): Promise<void>;
  /** Writes the full call. Moves it from the open set to the closed index when it is terminal. */
  save(call: Call): Promise<void>;
  remove(id: string): Promise<void>;
  get(id: string): Promise<Call | null>;
  listOpen(): Promise<Call[]>;
  /** Newest closed first. */
  listClosed(offset: number, limit: number): Promise<Call[]>;
  countClosed(): Promise<number>;
  /** Up to STATS_MAX_CALLS most recent closed calls, for the scoreboard. */
  allClosed(): Promise<Call[]>;
  /** SET NX with TTL; false when someone else holds it. */
  acquireLock(name: string, ttlSeconds: number): Promise<boolean>;
  releaseLock(name: string): Promise<void>;
}

const itemKey = (id: string): string => `calls:item:${id}`;
const OPEN_KEY = "calls:open";
const CLOSED_KEY = "calls:closed";
const lockKey = (name: string): string => `calls:lock:${name}`;

const STATUSES: readonly CallStatus[] = ["PENDING", "ACTIVE", "TP1_HIT", "TP2_HIT", "SL_HIT", "EXPIRED"];

export function callToFields(call: Call): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(call)) if (v !== undefined) out[k] = String(v);
  return out;
}

export function callFromFields(fields: Record<string, string>): Call | null {
  const num = (k: string): number | null => {
    const raw = fields[k];
    if (raw === undefined || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const entry = num("entry");
  const stopLoss = num("stopLoss");
  const tp1 = num("tp1");
  const tp2 = num("tp2");
  const confidence = num("confidence");
  const createdAt = num("createdAt");
  const validUntil = num("validUntil");
  const lastCheckedAt = num("lastCheckedAt");
  const status = fields.status as CallStatus;
  if ([entry, stopLoss, tp1, tp2, confidence, createdAt, validUntil, lastCheckedAt].some((v) => v === null)) return null;
  if (!fields.id || (fields.mode !== "day" && fields.mode !== "swing") || (fields.side !== "BUY" && fields.side !== "SELL")) return null;
  if (!STATUSES.includes(status)) return null;
  const call: Call = {
    id: fields.id,
    mode: fields.mode,
    side: fields.side,
    entry: entry as number,
    stopLoss: stopLoss as number,
    tp1: tp1 as number,
    tp2: tp2 as number,
    confidence: confidence as number,
    smcVerdict: (["agree", "neutral", "against", "unavailable"].includes(fields.smcVerdict) ? fields.smcVerdict : "unavailable") as Call["smcVerdict"],
    createdAt: createdAt as number,
    validUntil: validUntil as number,
    status,
    lastCheckedAt: lastCheckedAt as number,
  };
  for (const k of ["enteredAt", "tp1At", "closedAt", "resultR"] as const) {
    const v = num(k);
    if (v !== null) call[k] = v;
  }
  return call;
}

function pairsToFields(raw: unknown): Record<string, string> {
  const fields: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) fields[String(raw[i])] = String(raw[i + 1]);
  }
  return fields;
}

export function createRedisCallStore(options: RedisRestOptions): CallStore {
  const client: RedisClient = createRedisClient(options);

  async function load(ids: string[]): Promise<Call[]> {
    if (ids.length === 0) return [];
    const rows = await client.pipeline(ids.map((id) => ["HGETALL", itemKey(id)]));
    const calls: Call[] = [];
    for (const row of rows) {
      const call = callFromFields(pairsToFields(row));
      if (call) calls.push(call);
    }
    return calls;
  }

  const hset = (call: Call): Array<string | number> => ["HSET", itemKey(call.id), ...Object.entries(callToFields(call)).flat()];

  return {
    async create(call) {
      await client.pipeline([hset(call), ["SADD", OPEN_KEY, call.id]]);
    },
    async save(call) {
      if (!isTerminal(call.status)) {
        await client.pipeline([hset(call), ["SADD", OPEN_KEY, call.id]]);
        return;
      }
      await client.pipeline([
        hset(call),
        ["EXPIRE", itemKey(call.id), CLOSED_TTL_SECONDS],
        ["SREM", OPEN_KEY, call.id],
        ["ZADD", CLOSED_KEY, call.closedAt ?? call.lastCheckedAt, call.id],
        ["ZREMRANGEBYSCORE", CLOSED_KEY, "-inf", (call.closedAt ?? call.lastCheckedAt) - CLOSED_TTL_SECONDS * 1000],
      ]);
    },
    async remove(id) {
      await client.pipeline([["DEL", itemKey(id)], ["SREM", OPEN_KEY, id], ["ZREM", CLOSED_KEY, id]]);
    },
    async get(id) {
      return (await load([id]))[0] ?? null;
    },
    async listOpen() {
      const ids = (await client.command(["SMEMBERS", OPEN_KEY])) as string[] | null;
      const calls = await load(Array.isArray(ids) ? ids.map(String) : []);
      return calls.sort((a, b) => a.createdAt - b.createdAt);
    },
    async listClosed(offset, limit) {
      const ids = (await client.command(["ZREVRANGE", CLOSED_KEY, offset, offset + limit - 1])) as string[] | null;
      return load(Array.isArray(ids) ? ids.map(String) : []);
    },
    async countClosed() {
      return Number(await client.command(["ZCARD", CLOSED_KEY])) || 0;
    },
    async allClosed() {
      const ids = (await client.command(["ZREVRANGE", CLOSED_KEY, 0, STATS_MAX_CALLS - 1])) as string[] | null;
      return load(Array.isArray(ids) ? ids.map(String) : []);
    },
    async acquireLock(name, ttlSeconds) {
      return (await client.command(["SET", lockKey(name), "1", "NX", "EX", ttlSeconds])) === "OK";
    },
    async releaseLock(name) {
      await client.command(["DEL", lockKey(name)]);
    },
  };
}

/** In-memory store for tests. */
export function createMemoryCallStore(): CallStore & { calls: Map<string, Call>; locks: Set<string> } {
  const calls = new Map<string, Call>();
  const locks = new Set<string>();
  const closed = () => [...calls.values()].filter((c) => isTerminal(c.status)).sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
  return {
    calls,
    locks,
    async create(call) {
      calls.set(call.id, { ...call });
    },
    async save(call) {
      calls.set(call.id, { ...call });
    },
    async remove(id) {
      calls.delete(id);
    },
    async get(id) {
      return calls.get(id) ?? null;
    },
    async listOpen() {
      return [...calls.values()].filter((c) => !isTerminal(c.status)).sort((a, b) => a.createdAt - b.createdAt);
    },
    async listClosed(offset, limit) {
      return closed().slice(offset, offset + limit);
    },
    async countClosed() {
      return closed().length;
    },
    async allClosed() {
      return closed().slice(0, STATS_MAX_CALLS);
    },
    async acquireLock(name) {
      if (locks.has(name)) return false;
      locks.add(name);
      return true;
    },
    async releaseLock(name) {
      locks.delete(name);
    },
  };
}
