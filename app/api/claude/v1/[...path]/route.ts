import { POST as gatewayPost } from "@/app/api/vercel-gateway/v1/[...path]/route";
import { normalizeClaudeBody } from "@/lib/claude";

export { GET, PUT, PATCH, DELETE, OPTIONS } from "@/app/api/vercel-gateway/v1/[...path]/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = Parameters<typeof gatewayPost>[1];

export async function POST(req: Request, context: RouteContext) {
  const { path = [] } = await context.params;
  const endpoint = path.join("/");
  if (!["responses", "responses/compact", "chat/completions"].includes(endpoint)) {
    return gatewayPost(req, context);
  }
  const body = normalizeClaudeBody(await req.text());
  const headers = new Headers(req.headers);
  headers.delete("content-length");
  return gatewayPost(new Request(req, { headers, body }), context);
}
