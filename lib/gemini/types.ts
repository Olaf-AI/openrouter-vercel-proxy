export type JsonObject = Record<string, any>;

export type CanonicalToolCall = {
  toolCallId: string;
  toolName: string;
  input: unknown;
};

export type ToolMapping = {
  originalName: string;
  modelToolName: string;
  codexKind: "function" | "custom";
  namespace: string | null;
  rawCustom?: boolean;
  structuredApplyPatch?: boolean;
  patchPreflight?: unknown;
};

export type PendingTurn = {
  createdAt: string;
  responseMessages: JsonObject[];
  toolCalls: CanonicalToolCall[];
};

export type GeminiSessionState = {
  version: 1;
  sessionKey: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  messages: JsonObject[];
  systemText: string;
  workspaceCwd: string;
  externalFingerprints: string[];
  callMap: Record<string, ToolMapping>;
  pendingTurn: PendingTurn | null;
  legacyHealCount: number;
  modelToolMap: Record<string, ToolMapping>;
  requestCount: number;
  segment: number;
  rebaseCount: number;
  cumulativeUsage: {
    inputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    reasoningTokens: number;
  };
};
