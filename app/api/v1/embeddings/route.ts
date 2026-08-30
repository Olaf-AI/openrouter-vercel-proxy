import { z } from "zod";
import { authorizeOpenRouterRequest, callOpenRouter } from "@/lib/openrouter";
import { corsHeaders, isDeniedOrigin } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  model: z.string().min(1),
  input: z.union([
    z.string(),
    z.array(z.string()),
    z.array(z.number()),
    z.array(z.array(z.number())),
  ]),
}).passthrough();

export async function OPTIONS(req: Request) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(req.headers.get("origin")),
  });
}

export async function POST(req: Request) {
  const origin = req.headers.get("origin");

  try {
    if (isDeniedOrigin(origin)) {
      return Response.json(
        { ok: false, error: "Origin is denied." },
        { status: 403, headers: corsHeaders(origin) },
      );
    }

    const authorization = authorizeOpenRouterRequest(req);
    if (!authorization.ok) {
      return Response.json(
        { ok: false, error: authorization.error },
        { status: authorization.status, headers: corsHeaders(origin) },
      );
    }

    const body = bodySchema.parse(await req.json());
    const upstream = await callOpenRouter(
      "embeddings",
      body,
      authorization.apiKey,
    );

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...corsHeaders(origin),
        "Content-Type":
          upstream.headers.get("content-type") || "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return Response.json(
      { ok: false, error: message },
      { status: 400, headers: corsHeaders(origin) },
    );
  }
}
