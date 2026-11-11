import { handleScanRequest } from "@/lib/alerts/scan";

// Node.js runtime (timing-safe secret check); one scan = pipeline (<= 9 s) + Redis + Telegram.
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request): Promise<Response> {
  return handleScanRequest(request);
}

export async function GET(): Promise<Response> {
  return new Response(JSON.stringify({ status: "error", code: "METHOD_NOT_ALLOWED", message: "Use POST." }), {
    status: 405,
    headers: { "content-type": "application/json; charset=utf-8", allow: "POST", "cache-control": "no-store" },
  });
}
