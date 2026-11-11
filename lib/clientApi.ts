/** Browser-side call to POST /api/signal with friendly, actionable errors. */
import type { ApiErrorBody, Mode, SignalResponse } from "./types";

export class ClientError extends Error {
  readonly hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.name = "ClientError";
    this.hint = hint;
  }
}

function isApiError(body: unknown): body is ApiErrorBody {
  if (typeof body !== "object" || body === null) return false;
  const e = (body as { error?: unknown }).error;
  return typeof e === "object" && e !== null && typeof (e as { message?: unknown }).message === "string";
}

export function isSignalResponse(body: unknown): body is SignalResponse {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Partial<SignalResponse>;
  const bias = b.signal?.bias;
  return (
    (bias === "BUY" || bias === "SELL" || bias === "NO_TRADE") &&
    Array.isArray(b.signal?.technicalReasons) &&
    Array.isArray(b.snapshot?.timeframes) &&
    typeof b.snapshot?.price === "number" &&
    typeof b.meta?.durationMs === "number"
  );
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function requestSignal(mode: Mode, signal: AbortSignal, fetchImpl: FetchLike = fetch): Promise<SignalResponse> {
  let res: Response;
  try {
    res = await fetchImpl("/api/signal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
      signal,
    });
  } catch {
    if (signal.aborted) {
      throw new ClientError("The analysis took too long and was cancelled.", "Try again in a moment.");
    }
    throw new ClientError("Could not reach the server.", "Check your connection and try again.");
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    if (isApiError(body)) {
      throw new ClientError(body.error.message, body.error.hint ?? "Try again in a moment.");
    }
    if (res.status === 504) {
      throw new ClientError("The server hit its time limit (HTTP 504).", "Data sources may be slow right now. Try again.");
    }
    throw new ClientError(`The server returned HTTP ${res.status}.`, "Try again in a moment.");
  }
  if (!isSignalResponse(body)) {
    throw new ClientError("The server sent an unexpected response.", "Reload the page and try again.");
  }
  return body;
}
