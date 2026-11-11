import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseSignalRequest } from "../lib/signal/request";
import { AppError } from "../lib/server/errors";
import { clientKey, RateLimiter } from "../lib/server/rateLimit";

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return `${e.status} ${e.code}`;
    throw e;
  }
  return "ok";
}

const JSON_CT = "application/json";

describe("parseSignalRequest", () => {
  test("accepts exactly { mode: day | swing }", () => {
    assert.deepEqual(parseSignalRequest(JSON_CT, '{"mode":"day"}'), { mode: "day" });
    assert.deepEqual(parseSignalRequest("application/json; charset=utf-8", '{"mode":"swing"}'), { mode: "swing" });
  });

  test("rejects everything else with a precise error", () => {
    assert.equal(code(() => parseSignalRequest("text/plain", '{"mode":"day"}')), "415 UNSUPPORTED_MEDIA_TYPE");
    assert.equal(code(() => parseSignalRequest(null, '{"mode":"day"}')), "415 UNSUPPORTED_MEDIA_TYPE");
    assert.equal(code(() => parseSignalRequest(JSON_CT, "{mode: day}")), "400 INVALID_JSON");
    assert.equal(code(() => parseSignalRequest(JSON_CT, "")), "400 INVALID_JSON");
    assert.equal(code(() => parseSignalRequest(JSON_CT, '"day"')), "400 INVALID_BODY");
    assert.equal(code(() => parseSignalRequest(JSON_CT, '["day"]')), "400 INVALID_BODY");
    assert.equal(code(() => parseSignalRequest(JSON_CT, "null")), "400 INVALID_BODY");
    assert.equal(code(() => parseSignalRequest(JSON_CT, "{}")), "400 MISSING_MODE");
    assert.equal(code(() => parseSignalRequest(JSON_CT, '{"mode":"Day"}')), "400 INVALID_MODE");
    assert.equal(code(() => parseSignalRequest(JSON_CT, '{"mode":"scalp"}')), "400 INVALID_MODE");
    assert.equal(code(() => parseSignalRequest(JSON_CT, '{"mode":1}')), "400 INVALID_MODE");
    assert.equal(code(() => parseSignalRequest(JSON_CT, '{"mode":"day","symbol":"BTC"}')), "400 UNKNOWN_FIELD");
    assert.equal(code(() => parseSignalRequest(JSON_CT, `{"mode":"day","x":"${"a".repeat(2000)}"}`)), "413 PAYLOAD_TOO_LARGE");
  });

  test("errors carry a usage hint", () => {
    try {
      parseSignalRequest(JSON_CT, '{"mode":"scalp"}');
      assert.fail("should throw");
    } catch (e) {
      assert.ok(e instanceof AppError);
      assert.match(e.hint ?? "", /\{"mode":"day"\}/);
    }
  });
});

describe("RateLimiter", () => {
  test("allows `limit` hits per window per key", () => {
    let t = 0;
    const limiter = new RateLimiter(2, 60_000, () => t);
    assert.equal(limiter.check("a").allowed, true);
    assert.equal(limiter.check("a").allowed, true);
    const blocked = limiter.check("a");
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterSeconds, 60);
    assert.equal(limiter.check("b").allowed, true, "keys are independent");
    t = 60_001;
    assert.equal(limiter.check("a").allowed, true, "window slides");
  });

  test("client key uses the first forwarded IP", () => {
    assert.equal(clientKey(new Headers({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" })), "203.0.113.5");
    assert.equal(clientKey(new Headers({ "x-real-ip": "198.51.100.7" })), "198.51.100.7");
    assert.equal(clientKey(new Headers()), "unknown");
  });
});
