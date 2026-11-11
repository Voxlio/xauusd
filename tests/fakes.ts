/** Test doubles: a scripted fetch and a ready-made server config. */
import type { ServerConfig } from "../lib/server/env";
import type { FetchLike } from "../lib/server/http";

export interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

export type Route = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fetch that dispatches on URL substring; unmatched URLs fail like a network error. */
export function scriptedFetch(routes: Array<[string, Route]>): { fetchImpl: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const match = routes.find(([fragment]) => url.includes(fragment));
    if (!match) throw new TypeError("fetch failed");
    return match[1](url, init);
  };
  return { fetchImpl, calls };
}

/** Never resolves until the request is aborted, like a hung upstream. */
export const hangingRoute: Route = (_url, init) =>
  new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    twelveDataKey: "td-test-key",
    fredKey: "fred-test-key",
    finnhubKey: "fh-test-key",
    calendarFallback: "forexfactory",
    newsGate: "strict",
    ai: {
      provider: "anthropic",
      model: "claude-haiku-5-5",
      apiKey: "sk-ant-test",
      baseUrl: null,
      thinking: "off",
    },
    cacheTtlMs: 60_000,
    rateLimitPerMinute: 10,
    ...overrides,
  };
}
