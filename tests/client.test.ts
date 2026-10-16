import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ClientError, requestSignal } from "../lib/clientApi";
import { hangingRoute, jsonResponse, scriptedFetch } from "./fakes";

const validBody = {
  signal: { bias: "NO_TRADE", technicalReasons: [] },
  snapshot: { timeframes: [], price: 2400 },
  meta: { durationMs: 1200 },
};

async function rejection(promise: Promise<unknown>): Promise<ClientError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof ClientError) return e;
    throw e;
  }
  throw new Error("expected a ClientError");
}

describe("requestSignal (browser client)", () => {
  test("posts the mode and returns the response", async () => {
    const { fetchImpl, calls } = scriptedFetch([["/api/signal", () => jsonResponse(validBody)]]);
    const res = await requestSignal("swing", new AbortController().signal, fetchImpl);
    assert.equal(res.snapshot.price, 2400);
    assert.equal(calls[0].init?.body, '{"mode":"swing"}');
  });

  test("API errors keep the server message and hint", async () => {
    const { fetchImpl } = scriptedFetch([
      [
        "/api/signal",
        () => jsonResponse({ error: { code: "RATE_LIMITED", message: "Too many analyses.", hint: "Wait a minute." } }, 429),
      ],
    ]);
    const e = await rejection(requestSignal("day", new AbortController().signal, fetchImpl));
    assert.equal(e.message, "Too many analyses.");
    assert.equal(e.hint, "Wait a minute.");
  });

  test("non-JSON gateway timeouts get a readable message", async () => {
    const { fetchImpl } = scriptedFetch([["/api/signal", () => new Response("<html>timeout</html>", { status: 504 })]]);
    const e = await rejection(requestSignal("day", new AbortController().signal, fetchImpl));
    assert.match(e.message, /time limit/);
  });

  test("network failure and client timeout", async () => {
    const down = scriptedFetch([]);
    assert.match((await rejection(requestSignal("day", new AbortController().signal, down.fetchImpl))).message, /reach the server/);

    const slow = scriptedFetch([["/api/signal", hangingRoute]]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    assert.match((await rejection(requestSignal("day", controller.signal, slow.fetchImpl))).message, /took too long/);
  });

  test("unexpected 200 bodies are rejected", async () => {
    const { fetchImpl } = scriptedFetch([["/api/signal", () => jsonResponse({ hello: "world" })]]);
    const e = await rejection(requestSignal("day", new AbortController().signal, fetchImpl));
    assert.match(e.message, /unexpected response/);
  });
});
