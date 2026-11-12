/** Minimal Upstash Redis REST client over the injected fetch. Errors never contain the URL or the token. */
import type { FetchLike } from "../server/http";

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

export type RedisArg = string | number;

export interface RedisClient {
  command(args: RedisArg[]): Promise<unknown>;
  /** Runs several commands in one HTTP request (Upstash /pipeline); results are in the same order. */
  pipeline(commands: RedisArg[][]): Promise<unknown[]>;
}

export interface RedisRestOptions {
  url: string;
  token: string;
  fetchImpl: FetchLike;
  timeoutMs?: number;
}

export function createRedisClient({ url, token, fetchImpl, timeoutMs = 4_000 }: RedisRestOptions): RedisClient {
  const endpoint = url.replace(/\/+$/, "");

  async function post(path: string, payload: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(`${endpoint}${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
          cache: "no-store",
        });
      } catch {
        throw new StoreError(controller.signal.aborted ? "Redis timed out" : "Redis could not be reached");
      }
      if (!response.ok) throw new StoreError(`Redis request failed (HTTP ${response.status})`);
      return await response.json().catch(() => null);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async command(args) {
      const body = (await post("", args)) as { result?: unknown; error?: unknown } | null;
      if (!body || body.error) throw new StoreError("Redis returned an error");
      return body.result ?? null;
    },
    async pipeline(commands) {
      if (commands.length === 0) return [];
      const body = (await post("/pipeline", commands)) as Array<{ result?: unknown; error?: unknown }> | null;
      if (!Array.isArray(body) || body.length !== commands.length) throw new StoreError("Redis returned an unexpected pipeline reply");
      return body.map((item) => {
        if (!item || item.error) throw new StoreError("Redis returned an error");
        return item.result ?? null;
      });
    },
  };
}
