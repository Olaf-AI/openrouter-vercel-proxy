import { z } from "zod";
import { authorizeOpenRouterRequest } from "@/lib/openrouter";
import { corsHeaders, isDeniedOrigin } from "@/lib/security";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  input: z.union([z.string(), z.array(z.string())]),
  model: z.string().optional(),
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

    if (!env.OPENAI_MODERATION_API_KEY) {
      return Response.json(
        {
          ok: false,
          error: "OPENAI_MODERATION_API_KEY is not configured on the proxy.",
        },
        { status: 500, headers: corsHeaders(origin) },
      );
    }

    const body = bodySchema.parse(await req.json());
    const cleanBase = env.OPENAI_MODERATION_BASE_URL.replace(/\/+$/, "");
    const upstream = await fetch(`${cleanBase}/moderations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_MODERATION_API_KEY}`,
      },
      body: JSON.stringify({
        ...body,
        model: body.model || "omni-moderation-latest",
      }),
      cache: "no-store",
    });

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
