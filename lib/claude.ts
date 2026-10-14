function isInstruction(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const message = item as Record<string, unknown>;
  return (
    (message.type === undefined || message.type === "message") &&
    (message.role === "system" || message.role === "developer")
  );
}

// Claude compatibility: retain both groups' order and all message contents.
export function normalizeClaudeBody(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text; // Let the upstream validate malformed JSON as before.
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return text;
  const body = parsed as Record<string, unknown>;
  for (const key of ["input", "messages"]) {
    const items = body[key];
    if (Array.isArray(items)) {
      body[key] = [
        ...items.filter(isInstruction),
        ...items.filter(item => !isInstruction(item)),
      ];
    }
  }
  return JSON.stringify(body);
}
