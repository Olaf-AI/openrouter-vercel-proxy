import { env } from "@/lib/env";
import { extractApiKey } from "@/lib/api-key";
import { randomUUID } from "node:crypto";
import {
  logExternalApiError,
  logExternalApiFailure,
} from "@/lib/external-api-log";

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

export type ChatPayload = {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
};

export type OpenRouterAuthorization =
  | { ok: true; apiKey: string }
  | { ok: false; status: 401 | 500; error: string };

export function normalizeOpenRouterModel(model: string) {
  if (model.includes("/")) return model;
  if (/^(gpt-|o[134]-|text-embedding-)/.test(model)) {
    return `openai/${model}`;
  }
  return model;
}

export function authorizeOpenRouterRequest(
  req: Request,
): OpenRouterAuthorization {
  const clientApiKey = extractApiKey(req);

  if (env.OPENROUTER_API_KEY && !env.PROXY_API_KEY) {
    return {
      ok: false,
      status: 500,
      error:
        "PROXY_API_KEY must be configured when OPENROUTER_API_KEY is stored on the server.",
    };
  }

  if (env.PROXY_API_KEY && clientApiKey !== env.PROXY_API_KEY) {
    return {
      ok: false,
      status: 401,
      error: "Missing or invalid proxy API key.",
    };
  }

  if (env.OPENROUTER_API_KEY && env.PROXY_API_KEY) {
    return { ok: true, apiKey: env.OPENROUTER_API_KEY };
  }

  if (env.PROXY_API_KEY) {
    return {
      ok: false,
      status: 500,
      error:
        "OPENROUTER_API_KEY is not configured. PROXY_API_KEY only authenticates clients and cannot be used with OpenRouter.",
    };
  }

  if (clientApiKey) {
    return { ok: true, apiKey: clientApiKey };
  }

  return {
    ok: false,
    status: 401,
    error:
      "Missing API key. Configure OPENROUTER_API_KEY on the server or pass an OpenRouter key in Authorization: Bearer <key>.",
  };
}

export async function callOpenRouter(
  path: string,
  body: unknown,
  apiKey: string,
  init?: {
    method?: string;
  },
) {
  const cleanBase = env.OPENROUTER_BASE_URL.replace(/\/+$/, "");
  const cleanPath = path.replace(/^\/+/, "");
  const url = `${cleanBase}/${cleanPath}`;

  const method = init?.method ?? "POST";
  const proxyRequestId = randomUUID();
  const startedAt = performance.now();

  let upstreamBody = body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    upstreamBody = {
      ...record,
      ...(typeof record.model === "string"
        ? { model: normalizeOpenRouterModel(record.model) }
        : {}),
    };
  }

  const record =
    upstreamBody && typeof upstreamBody === "object" && !Array.isArray(upstreamBody)
      ? (upstreamBody as Record<string, unknown>)
      : undefined;
  const context = () => ({
    provider: "openrouter",
    proxyRequestId,
    method,
    path: cleanPath,
    upstreamHost: new URL(url).host,
    durationMs: Math.round(performance.now() - startedAt),
    ...(typeof record?.model === "string" ? { model: record.model } : {}),
    ...(typeof record?.stream === "boolean" ? { stream: record.stream } : {}),
  });

  try {
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": env.OPENROUTER_SITE_URL,
        "X-OpenRouter-Title": env.OPENROUTER_APP_NAME,
      },
      body: upstreamBody == null ? undefined : JSON.stringify(upstreamBody),
      cache: "no-store",
    });

    await logExternalApiError(res, context());
    return res;
  } catch (error) {
    logExternalApiFailure(error, context());
    throw error;
  }
}
