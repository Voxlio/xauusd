/**
 * In-memory TTL cache with request de-duplication and a stale fallback.
 * On Vercel this lives per warm function instance; it is a speed/credit saver,
 * not a source of truth.
 */
import { errorMessage } from "./errors";

export type CacheState = "fresh" | "cache" | "stale";

export interface CacheResult<T> {
  value: T;
  state: CacheState;
  ageMs: number;
  /** Error from the failed refresh when a stale value is served. */
  error: string | null;
}

interface Entry {
  value: unknown;
  storedAt: number;
}

export class TtlCache {
  private readonly store = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Returns a cached value younger than `ttlMs`, otherwise calls `loader`.
   * If the loader fails and a value younger than `staleMaxMs` exists, that
   * value is returned with state "stale"; otherwise the error is re-thrown.
   */
  async get<T>(key: string, ttlMs: number, staleMaxMs: number, loader: () => Promise<T>): Promise<CacheResult<T>> {
    const entry = this.store.get(key);
    const now = this.now();
    if (entry && now - entry.storedAt < ttlMs) {
      return { value: entry.value as T, state: "cache", ageMs: now - entry.storedAt, error: null };
    }

    let pending = this.inflight.get(key) as Promise<T> | undefined;
    if (!pending) {
      pending = loader();
      this.inflight.set(key, pending);
      pending.then(
        () => this.inflight.delete(key),
        () => this.inflight.delete(key),
      );
    }

    try {
      const value = await pending;
      this.store.set(key, { value, storedAt: this.now() });
      return { value, state: "fresh", ageMs: 0, error: null };
    } catch (error) {
      const fallback = this.store.get(key);
      const age = this.now() - (fallback?.storedAt ?? 0);
      if (fallback && age < staleMaxMs) {
        return { value: fallback.value as T, state: "stale", ageMs: age, error: errorMessage(error) };
      }
      throw error;
    }
  }

  clear(): void {
    this.store.clear();
    this.inflight.clear();
  }
}

/** Shared process-wide cache for market and macro data. */
export const dataCache = new TtlCache();
