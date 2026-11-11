/** fetch() with a hard timeout and JSON decoding. Errors never include the URL (it may hold an API key). */
import { UpstreamError } from "./errors";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FetchJsonOptions {
  fetchImpl: FetchLike;
  timeoutMs: number;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}

export interface JsonResponse {
  status: number;
  ok: boolean;
  data: unknown;
}

export async function fetchJson(source: string, url: string, options: FetchJsonOptions): Promise<JsonResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    let response: Response;
    try {
      response = await options.fetchImpl(url, {
        method: options.method ?? "GET",
        headers: { accept: "application/json", ...options.headers },
        body: options.body,
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new UpstreamError(source, "timeout", `${source} did not respond within ${(options.timeoutMs / 1000).toFixed(1)}s`);
      }
      const reason = error instanceof Error ? error.message : "network error";
      throw new UpstreamError(source, "network", `${source} could not be reached (${reason})`);
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      if (controller.signal.aborted) {
        throw new UpstreamError(source, "timeout", `${source} response timed out`, response.status);
      }
      throw new UpstreamError(source, "network", `${source} response could not be read`, response.status);
    }

    let data: unknown = null;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        if (!response.ok) {
          throw new UpstreamError(source, "http", `${source} returned HTTP ${response.status}`, response.status);
        }
        throw new UpstreamError(source, "parse", `${source} returned a non-JSON response`, response.status);
      }
    }
    return { status: response.status, ok: response.ok, data };
  } finally {
    clearTimeout(timer);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
