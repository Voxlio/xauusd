import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { TtlCache } from "../lib/server/cache";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("TtlCache", () => {
  test("serves cached values inside the TTL and refreshes after it", async () => {
    const c = clock();
    const cache = new TtlCache(c.now);
    let loads = 0;
    const loader = async () => ++loads;

    assert.equal((await cache.get("k", 60_000, 0, loader)).value, 1);
    c.advance(59_000);
    const hit = await cache.get("k", 60_000, 0, loader);
    assert.equal(hit.state, "cache");
    assert.equal(hit.ageMs, 59_000);
    c.advance(2_000);
    const miss = await cache.get("k", 60_000, 0, loader);
    assert.equal(miss.state, "fresh");
    assert.equal(miss.value, 2);
  });

  test("de-duplicates concurrent loads", async () => {
    const cache = new TtlCache();
    let loads = 0;
    const loader = () => new Promise<number>((resolve) => setTimeout(() => resolve(++loads), 10));
    const [a, b] = await Promise.all([cache.get("k", 1000, 0, loader), cache.get("k", 1000, 0, loader)]);
    assert.equal(loads, 1);
    assert.equal(a.value, 1);
    assert.equal(b.value, 1);
  });

  test("falls back to a stale value when a refresh fails", async () => {
    const c = clock();
    const cache = new TtlCache(c.now);
    await cache.get("k", 1000, 10_000, async () => "old");
    c.advance(5_000);
    const r = await cache.get("k", 1000, 10_000, async () => {
      throw new Error("upstream down");
    });
    assert.equal(r.state, "stale");
    assert.equal(r.value, "old");
    assert.equal(r.error, "upstream down");
  });

  test("re-throws when the stale value is too old or missing", async () => {
    const c = clock();
    const cache = new TtlCache(c.now);
    await assert.rejects(
      cache.get("k", 1000, 10_000, async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    await cache.get("k", 1000, 10_000, async () => "old");
    c.advance(20_000);
    await assert.rejects(
      cache.get("k", 1000, 10_000, async () => {
        throw new Error("still down");
      }),
      /still down/,
    );
  });
});
