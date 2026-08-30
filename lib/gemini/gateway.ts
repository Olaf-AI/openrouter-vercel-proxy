import crypto from "node:crypto";

import { createGateway } from "@ai-sdk/gateway";

import { extractApiKey } from "@/lib/api-key";

function configuredGatewayKey() {
  return (
    process.env.GEMINI_AI_GATEWAY_API_KEY?.trim() ||
    process.env.AI_GATEWAY_API_KEY?.trim() ||
    process.env.VERCEL_API_KEY?.trim() ||
    ""
  );
}

function configuredProxyKey() {
  return (
    process.env.GEMINI_PROXY_API_KEY?.trim() ||
    process.env.PROXY_API_KEY?.trim() ||
    ""
  );
}

function equalSecret(left: string | null, right: string) {
  if (!left) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export type GeminiAuthorization =
  | { ok: true; gatewayApiKey: string }
  | { ok: false; status: 401 | 500; error: string };

export function authorizeGeminiRequest(req: Request): GeminiAuthorization {
  const clientKey = extractApiKey(req);
  const upstreamKey = configuredGatewayKey();
  const proxyKey = configuredProxyKey();

  if (upstreamKey && !proxyKey) {
    return {
      ok: false,
      status: 500,
      error:
        "GEMINI_PROXY_API_KEY or PROXY_API_KEY must be configured when a Gemini AI Gateway key is stored on the server.",
    };
  }

  if (proxyKey && !equalSecret(clientKey, proxyKey)) {
    return { ok: false, status: 401, error: "Missing or invalid proxy API key." };
  }

  if (upstreamKey) return { ok: true, gatewayApiKey: upstreamKey };

  if (proxyKey) {
    return {
      ok: false,
      status: 500,
      error:
        "GEMINI_AI_GATEWAY_API_KEY, AI_GATEWAY_API_KEY, or VERCEL_API_KEY is not configured.",
    };
  }

  if (clientKey) return { ok: true, gatewayApiKey: clientKey };

  return {
    ok: false,
    status: 401,
    error:
      "Missing API key. Configure an AI Gateway key on the server or pass one as a Bearer token.",
  };
}

export function geminiModel(model: string, apiKey: string) {
  const baseURL = process.env.GEMINI_GATEWAY_BASE_URL?.trim();
  const gateway = createGateway({
    apiKey,
    ...(baseURL ? { baseURL: baseURL.replace(/\/+$/, "") } : {}),
  });
  return gateway(model as Parameters<typeof gateway>[0]);
}

export function defaultGeminiModel() {
  return process.env.GEMINI_DEFAULT_MODEL?.trim() || "google/gemini-3.7-flash";
}
