import { z } from "zod";
import { authorizeOpenRouterRequest } from "@/lib/openrouter";
import { corsHeaders, isDeniedOrigin } from "@/lib/security";
import { env } from "@/lib/env";
import { randomUUID } from "node:crypto";
import {
  logExternalApiError,
  logExternalApiFailure,
} from "@/lib/external-api-log";

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
    const url = `${cleanBase}/moderations`;
    const model = body.model || "omni-moderation-latest";
    const proxyRequestId = randomUUID();
    const startedAt = performance.now();
    const logContext = () => ({
      provider: "openai",
      proxyRequestId,
      method: "POST",
      path: "moderations",
      upstreamHost: new URL(url).host,
      durationMs: Math.round(performance.now() - startedAt),
      model,
    });

    let upstream: Response;
    try {
      upstream = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.OPENAI_MODERATION_API_KEY}`,
        },
        body: JSON.stringify({ ...body, model }),
        cache: "no-store",
      });
      await logExternalApiError(upstream, logContext());
    } catch (error) {
      logExternalApiFailure(error, logContext());
      throw error;
    }

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
