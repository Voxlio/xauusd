import type { TtlCache } from "../server/cache";
import type { ServerConfig } from "../server/env";
import type { FetchLike } from "../server/http";

/** Everything a data client needs; injected so tests can supply fakes. */
export interface DataContext {
  config: ServerConfig;
  fetchImpl: FetchLike;
  cache: TtlCache;
  timeoutMs: number;
}
