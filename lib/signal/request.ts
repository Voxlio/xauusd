/** Strict validation of the POST /api/signal request body. */
import { AppError } from "../server/errors";
import type { Mode } from "../types";

export const MAX_BODY_BYTES = 1024;
const MODES: readonly Mode[] = ["day", "swing"];
const EXAMPLE = 'Send a JSON body like {"mode":"day"} or {"mode":"swing"}.';

export interface SignalRequest {
  mode: Mode;
}

export function parseSignalRequest(contentType: string | null, body: string): SignalRequest {
  const mediaType = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.", EXAMPLE);
  }
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
    throw new AppError(413, "PAYLOAD_TOO_LARGE", `Request body must be at most ${MAX_BODY_BYTES} bytes.`, EXAMPLE);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new AppError(400, "INVALID_JSON", "Request body is not valid JSON.", EXAMPLE);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AppError(400, "INVALID_BODY", "Request body must be a JSON object.", EXAMPLE);
  }

  const keys = Object.keys(parsed);
  const unknown = keys.filter((k) => k !== "mode");
  if (unknown.length > 0) {
    throw new AppError(
      400,
      "UNKNOWN_FIELD",
      `Unknown field${unknown.length > 1 ? "s" : ""}: ${unknown.slice(0, 5).join(", ")}. Only "mode" is accepted.`,
      EXAMPLE,
    );
  }

  const mode = (parsed as { mode?: unknown }).mode;
  if (mode === undefined) throw new AppError(400, "MISSING_MODE", 'The "mode" field is required.', EXAMPLE);
  if (typeof mode !== "string" || !MODES.includes(mode as Mode)) {
    throw new AppError(400, "INVALID_MODE", 'The "mode" field must be "day" or "swing".', EXAMPLE);
  }
  return { mode: mode as Mode };
}
