const MAX_ERROR_BODY_LENGTH = 8_000;

const SENSITIVE_KEY =
  /authorization|api[-_]?key|token|secret|password|cookie/i;

type ExternalApiContext = {
  provider: string;
  proxyRequestId: string;
  method: string;
  path: string;
  upstreamHost: string;
  durationMs: number;
  model?: string;
  stream?: boolean;
};

function redactText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[REDACTED_API_KEY]");
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[TRUNCATED]";
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 50)
      .map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitize(item, depth + 1),
      ]),
  );
}

function summarizeErrorBody(text: string): unknown {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const useful = parsed.error ?? {
      message: parsed.message,
      code: parsed.code,
      type: parsed.type,
      details: parsed.details,
    };
    const safeBody = sanitize(useful);
    const serialized = JSON.stringify(safeBody);

    return {
      body:
        serialized.length > MAX_ERROR_BODY_LENGTH
          ? serialized.slice(0, MAX_ERROR_BODY_LENGTH)
          : safeBody,
      ...(serialized.length > MAX_ERROR_BODY_LENGTH
        ? { truncated: true }
        : {}),
    };
  } catch {
    const truncated = text.length > MAX_ERROR_BODY_LENGTH;
    return {
      body: redactText(text.slice(0, MAX_ERROR_BODY_LENGTH)),
      ...(truncated ? { truncated: true } : {}),
    };
  }
}

function writeErrorLog(payload: Record<string, unknown>) {
  // Keep this as a single JSON line so Vercel Logs can search individual fields.
  console.error("External API error", JSON.stringify(payload));
}

export async function logExternalApiError(
  response: Response,
  context: ExternalApiContext,
) {
  if (response.ok) return;

  let responseError: unknown = { body: "[unavailable]" };
  try {
    responseError = summarizeErrorBody(await response.clone().text());
  } catch (error) {
    responseError = {
      body: "[failed to read upstream error body]",
      readError: error instanceof Error ? error.message : "unknown error",
    };
  }

  writeErrorLog({
    event: "external_api_error",
    ...context,
    status: response.status,
    statusText: response.statusText,
    upstreamRequestId:
      response.headers.get("x-request-id") ||
      response.headers.get("x-vercel-id") ||
      response.headers.get("cf-ray"),
    responseError,
    vercel: {
      deploymentId: process.env.VERCEL_DEPLOYMENT_ID,
      region: process.env.VERCEL_REGION,
    },
  });
}

export function logExternalApiFailure(
  error: unknown,
  context: ExternalApiContext,
) {
  writeErrorLog({
    event: "external_api_failure",
    ...context,
    error: redactText(error instanceof Error ? error.message : String(error)),
    vercel: {
      deploymentId: process.env.VERCEL_DEPLOYMENT_ID,
      region: process.env.VERCEL_REGION,
    },
  });
}
