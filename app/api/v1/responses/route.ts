import { z } from "zod";
import { authorizeOpenRouterRequest, callOpenRouter } from "@/lib/openrouter";
import { corsHeaders, isDeniedOrigin } from "@/lib/security";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    model: z.string().optional(),
  })
  .passthrough();

function isValidResponsesTool(tool: Record<string, unknown>) {
  if (tool.type === "openrouter:datetime") return true;
  if (tool.type === "openrouter:web_search") return true;

  return (
    tool.type === "function" &&
    typeof tool.name === "string" &&
    !!tool.parameters &&
    typeof tool.parameters === "object"
  );
}

function normalizeResponsesBody(input: Record<string, unknown>) {
  const body = { ...input };

  delete body.client_metadata;

  if (Array.isArray(body.tools)) {
    body.tools = body.tools
      .filter(Boolean)
      .map((tool) => {
        if (!tool || typeof tool !== "object") return null;

        const t = tool as Record<string, unknown>;

        if (
          t.type === "function" &&
          t.function &&
          typeof t.function === "object"
        ) {
          const fn = t.function as Record<string, unknown>;
          const { function: _ignored, ...rest } = t;

          return {
            ...rest,
            type: "function",
            name: fn.name,
            description: fn.description,
            parameters: fn.parameters,
            ...(fn.strict !== undefined ? { strict: fn.strict } : {}),
          };
        }

        return t;
      })
      .filter((tool): tool is Record<string, unknown> => {
        if (!tool) return false;
        const ok = isValidResponsesTool(tool);
        if (!ok) {
          console.warn("Dropping unsupported Responses tool", {
            type: tool.type,
            name: tool.name,
          });
        }
        return ok;
      });
  }

  return body;
}

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
        { status: 403, headers: corsHeaders(origin) },
      );
    }

    const authorization = authorizeOpenRouterRequest(req);
    if (!authorization.ok) {
      return Response.json(
        {
          ok: false,
          error: authorization.error,
        },
        { status: authorization.status, headers: corsHeaders(origin) },
      );
    }

    const json = await req.json();
    const parsed = bodySchema.parse(json);
    const upstreamBody = normalizeResponsesBody({
      ...parsed,
      model: parsed.model || env.DEFAULT_MODEL,
    });

    console.info("OpenRouter Responses request", {
      model: upstreamBody.model,
      stream: upstreamBody.stream === true,
      toolCount: Array.isArray(upstreamBody.tools)
        ? upstreamBody.tools.length
        : 0,
    });

    const upstream = await callOpenRouter(
      "responses",
      upstreamBody,
      authorization.apiKey,
    );

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...corsHeaders(origin),
        "Content-Type":
          upstream.headers.get("content-type") || "application/json",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
        ...(upstream.headers.get("x-request-id")
          ? { "X-Request-Id": upstream.headers.get("x-request-id")! }
          : {}),
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
