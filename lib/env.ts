function splitCsv(value?: string): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const env = {
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY?.trim() || "",

  PROXY_API_KEY: process.env.PROXY_API_KEY?.trim() || "",

  OPENROUTER_BASE_URL:
    process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1",

  OPENROUTER_APP_NAME:
    process.env.OPENROUTER_APP_NAME?.trim() || "OpenRouter Vercel Proxy",

  OPENROUTER_SITE_URL:
    process.env.OPENROUTER_SITE_URL?.trim() || "http://localhost:3000",

  VERCEL_GATEWAY_BASE_URL:
    process.env.VERCEL_GATEWAY_BASE_URL?.trim() ||
    process.env.AI_GATEWAY_BASE_URL?.trim() ||
    "https://ai-gateway.vercel.sh/v1",

  VERCEL_GATEWAY_APP_NAME:
    process.env.VERCEL_GATEWAY_APP_NAME?.trim() ||
    process.env.AI_GATEWAY_APP_NAME?.trim() ||
    process.env.OPENROUTER_APP_NAME?.trim() ||
    "Vercel AI Gateway Proxy",

  VERCEL_GATEWAY_SITE_URL:
    process.env.VERCEL_GATEWAY_SITE_URL?.trim() ||
    process.env.AI_GATEWAY_SITE_URL?.trim() ||
    process.env.OPENROUTER_SITE_URL?.trim() ||
    "http://localhost:3000",

  DENY_ORIGINS: splitCsv(process.env.DENY_ORIGINS),
  DENY_HOSTS: splitCsv(process.env.DENY_HOSTS),
  DENY_LOCALHOST: (process.env.DENY_LOCALHOST?.trim() || "false") === "true",

  DEFAULT_MODEL: process.env.DEFAULT_MODEL?.trim() || "openai/gpt-4o-mini",
  VERCEL_GATEWAY_DEFAULT_MODEL:
    process.env.VERCEL_GATEWAY_DEFAULT_MODEL?.trim() ||
    process.env.AI_GATEWAY_MODEL?.trim() ||
    process.env.DEFAULT_MODEL?.trim() ||
    "openai/gpt-4o-mini",
};
