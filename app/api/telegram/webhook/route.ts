import { handleWebhookRequest } from "@/lib/alerts/webhook";

// Node.js runtime (timing-safe secret check). Telegram expects a fast 200.
export const runtime = "nodejs";
export const maxDuration = 10;

export async function POST(request: Request): Promise<Response> {
  return handleWebhookRequest(request);
}

export async function GET(): Promise<Response> {
  return new Response(JSON.stringify({ ok: false, error: "Use POST." }), {
    status: 405,
    headers: { "content-type": "application/json; charset=utf-8", allow: "POST", "cache-control": "no-store" },
  });
}
