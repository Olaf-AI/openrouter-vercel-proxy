export function extractApiKey(req: Request): string | null {
  const authorization = req.headers.get("authorization")?.trim();
  const headerCandidates = [
    req.headers.get("x-ai-gateway-api-key")?.trim(),
    req.headers.get("x-vercel-ai-gateway-api-key")?.trim(),
    req.headers.get("x-openrouter-api-key")?.trim(),
    req.headers.get("x-api-key")?.trim(),
  ];

  for (const apiKey of headerCandidates) {
    if (apiKey) return apiKey;
  }

  if (authorization?.toLowerCase().startsWith("bearer ")) {
    const token = authorization.slice(7).trim();
    if (token) return token;
  }

  return null;
}
