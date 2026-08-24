import { z } from "zod";

import { authorizeGeminiRequest } from "@/lib/gemini/gateway";
import { createGeminiResponsesStream } from "@/lib/gemini/responses";
import type { JsonObject } from "@/lib/gemini/types";
import { corsHeaders, isDeniedOrigin } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const bodySchema = z
  .object({
    model: z.string().optional(),
    input: z.union([z.string(), z.array(z.unknown())]),
    stream: z.boolean().optional(),
  })
  .passthrough();

export async function OPTIONS(req: Request) {
  const origin = req.headers.get("origin");
  return new Response(null, {
    status: isDeniedOrigin(origin) ? 403 : 204,
    headers: corsHeaders(origin),
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

    const authorization = authorizeGeminiRequest(req);
    if (!authorization.ok) {
      return Response.json(
        { ok: false, error: authorization.error },
        { status: authorization.status, headers: corsHeaders(origin) },
      );
    }

    const body = bodySchema.parse(await req.json()) as JsonObject;
    const stream = createGeminiResponsesStream(
      req,
      body,
      authorization.gatewayApiKey,
    );

    return new Response(stream, {
      status: 200,
      headers: {
        ...corsHeaders(origin),
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { ok: false, error: message },
      { status: 400, headers: corsHeaders(origin) },
    );
  }
}
