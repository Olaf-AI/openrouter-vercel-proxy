import { z } from "zod";
import { authorizeOpenRouterRequest, callOpenRouter } from "@/lib/openrouter";
import { corsHeaders, isDeniedOrigin } from "@/lib/security";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([
    z.string(),
    z.array(z.record(z.unknown())).min(1),
  ]),
}).passthrough();

const bodySchema = z.object({
  model: z.string().optional(),
  messages: z.array(messageSchema).min(1),
}).passthrough();

export async function OPTIONS(req: Request) {
  const origin = req.headers.get("origin");
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin),
  });
}

export async function POST(req: Request) {
  const origin = req.headers.get("origin");

  try {
    if (isDeniedOrigin(origin)) {
      return Response.json(
        { ok: false, error: "Origin is denied." },
        {
          status: 403,
          headers: corsHeaders(origin),
        },
      );
    }

    const authorization = authorizeOpenRouterRequest(req);
    if (!authorization.ok) {
      return Response.json(
        {
          ok: false,
          error: authorization.error,
        },
        {
          status: authorization.status,
          headers: corsHeaders(origin),
        },
      );
    }

    const json = await req.json();
    const body = bodySchema.parse(json);

    const upstream = await callOpenRouter(
      "chat/completions",
      {
        ...body,
        model: body.model || env.DEFAULT_MODEL,
      },
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
      {
        status: 400,
        headers: corsHeaders(origin),
      },
    );
  }
}
