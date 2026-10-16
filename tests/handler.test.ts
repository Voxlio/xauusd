import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { handleSignalRequest, type HandlerDeps } from "../lib/server/handler";
import { TtlCache } from "../lib/server/cache";
import { RateLimiter } from "../lib/server/rateLimit";
import type { ApiErrorBody, SignalResponse } from "../lib/types";
import { scriptedFetch } from "./fakes";
import { compliantBuy, fakeAI, finnhubRoute, fredRoute, MARKET_NOW, marketCandles, twelveDataRoute } from "./market";

const ENV = {
  TWELVE_DATA_API_KEY: "td-secret-123",
  FRED_API_KEY: "fred-secret-456",
  FINNHUB_API_KEY: "fh-secret-789",
  ANTHROPIC_API_KEY: "sk-ant-secret",
};
const candles = marketCandles();

function deps(overrides: Partial<HandlerDeps> = {}): Partial<HandlerDeps> {
  const { fetchImpl } = scriptedFetch([
    ["api.twelvedata.com", twelveDataRoute(candles)],
    ["api.stlouisfed.org", fredRoute],
    ["finnhub.io", finnhubRoute()],
  ]);
  return {
    env: ENV,
    fetchImpl,
    cache: new TtlCache(),
    limiter: new RateLimiter(100),
    createProvider: () => fakeAI(compliantBuy),
    now: () => MARKET_NOW,
    ...overrides,
  };
}

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://xauusd.example/api/signal", {
    method: "POST",
    headers: { "content-type": "application/json", host: "xauusd.example", ...headers },
    body,
  });
}

async function errorOf(res: Response): Promise<ApiErrorBody["error"]> {
  const body = (await res.json()) as ApiErrorBody;
  return body.error;
}

describe("POST /api/signal handler", () => {
  test("200 with signal, snapshot and no-store caching", async () => {
    const res = await handleSignalRequest(post('{"mode":"day"}'), deps());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const text = await res.text();
    for (const secret of Object.values(ENV)) assert.ok(!text.includes(secret), "no secrets in the response");
    const body = JSON.parse(text) as SignalResponse;
    assert.equal(body.signal.bias, "BUY");
    assert.equal(body.snapshot.symbol, "XAU/USD");
    assert.equal(body.snapshot.mode, "day");
  });

  test("405 for other methods", async () => {
    const res = await handleSignalRequest(new Request("https://xauusd.example/api/signal"), deps());
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "POST");
  });

  test("400 / 413 / 415 for bad input, with hints", async () => {
    assert.equal((await handleSignalRequest(post('{"mode":"weekly"}'), deps())).status, 400);
    assert.equal((await handleSignalRequest(post("not json"), deps())).status, 400);
    assert.equal((await handleSignalRequest(post('{"mode":"day"}', { "content-type": "text/plain" }), deps())).status, 415);
    assert.equal((await handleSignalRequest(post('{"mode":"day"}', { "content-length": "5000" }), deps())).status, 413);
    const err = await errorOf(await handleSignalRequest(post('{"mode":"day","extra":1}'), deps()));
    assert.equal(err.code, "UNKNOWN_FIELD");
    assert.ok(err.hint);
  });

  test("403 for cross-site browser requests, same-origin allowed", async () => {
    const cross = await handleSignalRequest(post('{"mode":"day"}', { origin: "https://evil.example" }), deps());
    assert.equal(cross.status, 403);
    const same = await handleSignalRequest(post('{"mode":"day"}', { origin: "https://xauusd.example" }), deps());
    assert.equal(same.status, 200);
  });

  test("500 with the missing variable named when keys are not configured", async () => {
    const res = await handleSignalRequest(post('{"mode":"day"}'), deps({ env: {} }));
    assert.equal(res.status, 500);
    const err = await errorOf(res);
    assert.equal(err.code, "CONFIG_MISSING");
    assert.match(err.message, /TWELVE_DATA_API_KEY/);
    assert.match(err.hint ?? "", /\.env\.local/);
  });

  test("429 with Retry-After once the per-IP limit is hit", async () => {
    const d = deps({ limiter: new RateLimiter(1) });
    assert.equal((await handleSignalRequest(post('{"mode":"day"}', { "x-forwarded-for": "1.2.3.4" }), d)).status, 200);
    const limited = await handleSignalRequest(post('{"mode":"day"}', { "x-forwarded-for": "1.2.3.4" }), d);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
  });

  test("upstream failure returns 502 JSON without leaking keys", async () => {
    const { fetchImpl } = scriptedFetch([]);
    const res = await handleSignalRequest(post('{"mode":"swing"}'), deps({ fetchImpl }));
    assert.equal(res.status, 502);
    const text = await res.text();
    for (const secret of Object.values(ENV)) assert.ok(!text.includes(secret));
    assert.equal((JSON.parse(text) as ApiErrorBody).error.code, "MARKET_DATA_UNAVAILABLE");
  });

  test("unexpected exceptions become a generic 500 and logs are redacted", async () => {
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => logged.push(args.join(" "));
    let res: Response;
    try {
      res = await handleSignalRequest(
        post('{"mode":"day"}'),
        deps({
          createProvider: () => {
            throw new Error("kaboom with sk-ant-secret");
          },
        }),
      );
    } finally {
      console.error = original;
    }
    assert.equal(res.status, 500);
    const err = await errorOf(res);
    assert.equal(err.code, "INTERNAL_ERROR");
    assert.ok(!err.message.includes("sk-ant-secret"));
    assert.equal(logged.length, 1);
    assert.match(logged[0], /kaboom with \[redacted\]/);
  });
});
