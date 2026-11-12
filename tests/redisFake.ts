/** A tiny Upstash-REST-compatible Redis emulator over a fake fetch, covering the commands the stores use. */
import type { FetchLike } from "../lib/server/http";

type Cmd = Array<string | number>;

export function createRedisEmulator() {
  const strings = new Map<string, string>();
  const hashes = new Map<string, Map<string, string>>();
  const sets = new Map<string, Set<string>>();
  const zsets = new Map<string, Map<string, number>>();
  const expires = new Map<string, number>();
  const log: Cmd[] = [];

  function run(cmd: Cmd): unknown {
    log.push(cmd);
    const [name, key, ...rest] = cmd.map((x) => (typeof x === "number" ? x : String(x))) as [string, string, ...Array<string | number>];
    const op = String(name).toUpperCase();
    const k = String(key);
    switch (op) {
      case "GET":
        return strings.get(k) ?? null;
      case "SET": {
        const nx = rest.map(String).includes("NX");
        if (nx && strings.has(k)) return null;
        strings.set(k, String(rest[0]));
        return "OK";
      }
      case "DEL":
        strings.delete(k);
        hashes.delete(k);
        return 1;
      case "HSET": {
        const h = hashes.get(k) ?? new Map<string, string>();
        for (let i = 0; i + 1 < rest.length; i += 2) h.set(String(rest[i]), String(rest[i + 1]));
        hashes.set(k, h);
        return rest.length / 2;
      }
      case "HGETALL":
        return [...(hashes.get(k) ?? new Map()).entries()].flat();
      case "EXPIRE":
        expires.set(k, Number(rest[0]));
        return 1;
      case "SADD":
        sets.set(k, (sets.get(k) ?? new Set()).add(String(rest[0])));
        return 1;
      case "SREM":
        sets.get(k)?.delete(String(rest[0]));
        return 1;
      case "SMEMBERS":
        return [...(sets.get(k) ?? new Set())];
      case "ZADD": {
        const z = zsets.get(k) ?? new Map<string, number>();
        z.set(String(rest[1]), Number(rest[0]));
        zsets.set(k, z);
        return 1;
      }
      case "ZREM":
        zsets.get(k)?.delete(String(rest[0]));
        return 1;
      case "ZCARD":
        return zsets.get(k)?.size ?? 0;
      case "ZREMRANGEBYSCORE": {
        const max = String(rest[1]) === "-inf" ? -Infinity : Number(rest[1]);
        const z = zsets.get(k);
        if (z) for (const [member, score] of [...z]) if (score <= max) z.delete(member);
        return 0;
      }
      case "ZREVRANGE": {
        const ordered = [...(zsets.get(k) ?? new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
        return ordered.slice(Number(rest[0]), Number(rest[1]) + 1);
      }
      default:
        throw new Error(`unsupported command ${op}`);
    }
  }

  const fetchImpl: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Cmd | Cmd[];
    const headers = { "content-type": "application/json" };
    if (url.endsWith("/pipeline")) {
      return new Response(JSON.stringify((body as Cmd[]).map((c) => ({ result: run(c) }))), { headers });
    }
    return new Response(JSON.stringify({ result: run(body as Cmd) }), { headers });
  };

  return { fetchImpl, strings, hashes, sets, zsets, expires, log };
}
