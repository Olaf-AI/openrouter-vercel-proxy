import { createHash, randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { extractApiKey } from "@/lib/api-key";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

function shouldForwardRequestHeader(name: string): boolean {
  const lower = name.toLowerCase();

  if (HOP_BY_HOP_HEADERS.has(lower)) return false;

  // 避免把浏览器侧自己的 key 透传给上游。
  if (lower === "x-openrouter-api-key") return false;
  if (lower === "x-ai-gateway-api-key") return false;
  if (lower === "x-vercel-ai-gateway-api-key") return false;
  if (lower === "x-api-key") return false;
  if (lower === "authorization") return false;

  return true;
}

function buildForwardHeaders(req: Request, apiKey: string): Headers {
  const headers = new Headers();

  for (const [name, value] of req.headers.entries()) {
    if (shouldForwardRequestHeader(name)) {
      headers.set(name, value);
    }
  }

  headers.set("Authorization", `Bearer ${apiKey}`);

  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  if (env.VERCEL_GATEWAY_SITE_URL) {
    headers.set("HTTP-Referer", env.VERCEL_GATEWAY_SITE_URL);
  }

  if (env.VERCEL_GATEWAY_APP_NAME) {
    headers.set("X-Title", env.VERCEL_GATEWAY_APP_NAME);
  }

  return headers;
}

function buildGatewayUrl(path: string, req: Request): string {
  const cleanBase = env.VERCEL_GATEWAY_BASE_URL.replace(/\/+$/, "");
  const cleanPath = path.replace(/^\/+/, "");

  const incomingUrl = new URL(req.url);
  const upstreamUrl = new URL(`${cleanBase}/${cleanPath}`);

  upstreamUrl.search = incomingUrl.search;

  return upstreamUrl.toString();
}

async function readRequestBody(req: Request): Promise<BodyInit | undefined> {
  const method = req.method.toUpperCase();

  if (method === "GET" || method === "HEAD") {
    return undefined;
  }

  const text = await req.text();

  return text ? text : undefined;
}

function keyFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 12);
}

export async function callVercelGateway(req: Request, path: string) {
  const apiKey = extractApiKey(req);

  if (!apiKey) {
    throw new Error(
      "Missing Vercel AI Gateway API key. Pass it in x-ai-gateway-api-key, x-vercel-ai-gateway-api-key, x-api-key, or Authorization: Bearer <key>.",
    );
  }

  const url = buildGatewayUrl(path, req);
  const body = await readRequestBody(req);
  const proxyRequestId = randomUUID();
  const fingerprint = keyFingerprint(apiKey);

  console.info("Vercel Gateway upstream request", {
    proxyRequestId,
    method: req.method,
    path,
    upstreamHost: new URL(url).host,
    keyFingerprint: fingerprint,
  });

  try {
    const response = await fetch(url, {
      method: req.method,
      headers: buildForwardHeaders(req, apiKey),
      body,
      cache: "no-store",
    });

    console.info("Vercel Gateway upstream response", {
      proxyRequestId,
      status: response.status,
      keyFingerprint: fingerprint,
      upstreamRequestId:
        response.headers.get("x-request-id") ||
        response.headers.get("x-vercel-id"),
    });

    return response;
  } catch (error) {
    console.error("Vercel Gateway upstream failure", {
      proxyRequestId,
      keyFingerprint: fingerprint,
      error: error instanceof Error ? error.message : "unknown error",
    });
    throw error;
  }
}
