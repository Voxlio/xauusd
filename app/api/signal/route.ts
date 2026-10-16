import { handleSignalRequest } from "@/lib/server/handler";

// Node.js runtime; the handler keeps its own budget under 9 s.
export const runtime = "nodejs";
export const maxDuration = 10;

export async function POST(request: Request): Promise<Response> {
  return handleSignalRequest(request);
}
