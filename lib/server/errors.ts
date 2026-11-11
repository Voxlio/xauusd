/** Error types with HTTP semantics and a user-facing hint. */

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint: string | null;

  constructor(status: number, code: string, message: string, hint: string | null = null) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

export type UpstreamErrorKind = "timeout" | "network" | "http" | "parse" | "api";

/** A failure talking to a data provider. Messages never contain URLs or keys. */
export class UpstreamError extends Error {
  readonly source: string;
  readonly kind: UpstreamErrorKind;
  readonly status: number | null;

  constructor(source: string, kind: UpstreamErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = "UpstreamError";
    this.source = source;
    this.kind = kind;
    this.status = status;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Unknown error";
}
