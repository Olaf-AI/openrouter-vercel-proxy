import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { jsonSchema } from "ai";

import type {
  CanonicalToolCall,
  GeminiSessionState,
  JsonObject,
  ToolMapping,
} from "@/lib/gemini/types";

export function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}

export function sha256(value: unknown) {
  return crypto
    .createHash("sha256")
    .update(typeof value === "string" ? value : stableStringify(value))
    .digest("hex");
}

export function shortSession(key: string) {
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 8);
}

export function getSessionKey(headers: Headers, body: JsonObject) {
  for (const name of [
    "thread-id",
    "session-id",
    "x-client-request-id",
    "x-codex-session-id",
    "conversation-id",
  ]) {
    const value = headers.get(name)?.trim();
    if (value) return `${name}:${value}`;
  }

  const metadata = body.client_metadata;
  if (metadata && typeof metadata === "object") {
    for (const key of ["thread_id", "session_id", "conversation_id"]) {
      const value = (metadata as JsonObject)[key];
      if (value) return `metadata:${key}:${value}`;
    }
  }

  return "fallback:default";
}

function codexMessageText(item: JsonObject) {
  const content = item?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const chunks: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (
      ["input_text", "output_text", "text"].includes(String(part.type)) &&
      typeof part.text === "string"
    ) {
      chunks.push(part.text);
    }
  }
  return chunks.join("\n");
}

function isToolOutput(item: JsonObject) {
  const type = String(item?.type ?? "");
  return (
    type === "function_call_output" ||
    type === "custom_tool_call_output" ||
    type === "local_shell_call_output" ||
    type === "shell_call_output" ||
    type === "computer_call_output" ||
    type.endsWith("_call_output")
  );
}

function isExternalItem(item: JsonObject) {
  if (!item || typeof item !== "object") return false;
  if (item.type === "message") {
    return ["user", "developer", "system"].includes(String(item.role));
  }
  return isToolOutput(item) || item.type === "mcp_approval_response";
}

function externalSequence(input: unknown) {
  if (!Array.isArray(input)) return [];
  return input.filter(
    (item): item is JsonObject =>
      Boolean(item) && typeof item === "object" && isExternalItem(item),
  );
}

function normalizedExternalFingerprint(item: JsonObject) {
  if (item.type === "message") {
    return sha256({
      type: "message",
      role: item.role,
      content: item.content,
    });
  }
  if (isToolOutput(item)) {
    return sha256({
      type: item.type,
      call_id: item.call_id ?? item.tool_call_id ?? null,
      output: item.output ?? item.content ?? item.result ?? null,
    });
  }
  return sha256(item);
}

function isPrefix(oldSequence: string[], newSequence: string[]) {
  return (
    oldSequence.length <= newSequence.length &&
    oldSequence.every((value, index) => newSequence[index] === value)
  );
}

function codexUserToModelMessage(item: JsonObject): JsonObject | null {
  const text = codexMessageText(item);
  if (!text) return null;
  return { role: "user", content: [{ type: "text", text }] };
}

function buildSystemText(body: JsonObject, externalItems: JsonObject[]) {
  const chunks: string[] = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) {
    chunks.push(body.instructions.trim());
  }
  for (const item of externalItems) {
    if (
      item.type === "message" &&
      ["developer", "system"].includes(String(item.role))
    ) {
      const text = codexMessageText(item).trim();
      if (text) chunks.push(text);
    }
  }
  return chunks.join("\n\n");
}

function parseToolOutputValue(item: JsonObject) {
  const value = item.output ?? item.content ?? item.result ?? "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function sanitizeToolName(name: unknown) {
  const sanitized = String(name ?? "tool")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 120);
  return sanitized || "tool";
}

function uniqueToolName(base: string, used: Set<string>) {
  const name = sanitizeToolName(base);
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  for (let index = 2; index < 1000; index += 1) {
    const suffix = `_${index}`;
    const candidate = name.slice(0, 128 - suffix.length) + suffix;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  throw new Error(`Could not allocate unique tool name for ${base}`);
}

export function toolChoiceToAiSdk(
  toolChoice: unknown,
  state: GeminiSessionState,
) {
  if (toolChoice == null || toolChoice === "auto") return "auto";
  if (toolChoice === "none") return "none";
  if (toolChoice === "required") return "required";
  if (typeof toolChoice === "object") {
    const choice = toolChoice as JsonObject;
    const rawName = choice.name ?? choice.function?.name ?? choice.tool?.name;
    if (rawName) {
      for (const [modelName, info] of Object.entries(state.modelToolMap)) {
        if (info.originalName === rawName || modelName === rawName) {
          return { type: "tool" as const, toolName: modelName };
        }
      }
      return { type: "tool" as const, toolName: sanitizeToolName(rawName) };
    }
  }
  return "auto";
}

const APPLY_PATCH_STRUCTURED_SCHEMA = {
  type: "object",
  properties: {
    operations: {
      type: "array",
      minItems: 1,
      description:
        "File edits to apply in order. Do NOT write patch syntax yourself; " +
        "the bridge renders Codex apply_patch syntax deterministically.",
      items: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["add", "delete", "update"],
            description: "add=create file, delete=remove file, update=edit existing file",
          },
          path: {
            type: "string",
            description:
              "Workspace-relative file path. Prefer relative paths and never " +
              "put diff markers or line ranges here.",
          },
          move_to: {
            type: "string",
            description: "Optional new workspace-relative path for an update/rename.",
          },
          content: {
            type: "string",
            description:
              "For action=add only: complete new file contents. The bridge " +
              "will prefix every line with + automatically.",
          },
          hunks: {
            type: "array",
            description:
              "For action=update only: exact edits. Do not use unified-diff " +
              "line-number headers such as @@ -1,3 +1,4 @@.",
            items: {
              type: "object",
              properties: {
                anchor: {
                  type: "string",
                  description:
                    'Optional semantic anchor such as "function render()" or ' +
                    '"class Foo". Never use numeric unified-diff ranges.',
                },
                before: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Unchanged context lines immediately before the edit. " +
                    "Each array element must be one source line.",
                },
                old: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Exact existing lines to remove/replace. Each element is one line.",
                },
                new: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Replacement/new lines. Each element is one line.",
                },
                after: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Unchanged context lines immediately after the edit. " +
                    "Each array element must be one source line.",
                },
                end_of_file: {
                  type: "boolean",
                  description:
                    "Set true only when this hunk intentionally targets the end of file.",
                },
              },
              additionalProperties: false,
            },
          },
        },
        required: ["action", "path"],
        additionalProperties: false,
      },
    },
  },
  required: ["operations"],
  additionalProperties: false,
};

const APPLY_PATCH_STRUCTURED_DESCRIPTION = `
Edit files using Codex apply_patch semantics, but DO NOT emit patch text.

Return structured operations only. The bridge will deterministically render:
*** Begin Patch
*** Add File: ...
*** Delete File: ...
*** Update File: ...
@@ optional semantic anchor
 context
-old
+new
 context
*** End Patch

Rules:
- For add: set action="add", path, and content.
- For delete: set action="delete" and path.
- For update: set action="update", path, and one or more hunks.
- Every before/old/new/after array element is exactly one source line.
- Keep old as the SMALLEST exact sequence that identifies the change.
- before/after are only disambiguation hints; do not copy large stale regions.
- old/context lines must come from the most recent file read.
- anchor is optional and semantic only (class/function/snippet label).
- NEVER use unified-diff numeric ranges like "-1,13 +1,20".
- NEVER include "*** Begin Patch", "*** End Patch", "@@", "+", "-", or " "
  diff prefixes inside the line arrays; the bridge adds all syntax.
- Prefer small, precise hunks. The bridge preflights the current local file
  and will discard stale before/after context when old matches uniquely.
- If an earlier apply_patch result says it failed to find context, READ the
  current target file again before retrying. Never resend the same stale hunk
  unchanged after a context-mismatch failure.
`.trim();

function isApplyPatchTool(name: unknown) {
  return String(name ?? "").toLowerCase() === "apply_patch";
}

function splitLogicalLines(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry) =>
      String(entry ?? "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .split("\n"),
    );
  }
  return String(value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");
}

function sanitizeApplyPatchAnchor(anchor: unknown) {
  if (anchor == null) return "";
  const value = String(anchor)
    .trim()
    .replace(/^@@\s*/, "")
    .replace(/\s*@@$/, "")
    .trim();
  if (/^-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?(?:\s|$)/.test(value)) return "";
  return value;
}

function validateApplyPatchPath(filePath: unknown) {
  const value = String(filePath ?? "").trim();
  if (!value) throw new Error("apply_patch operation is missing path");
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error(`apply_patch path contains a newline: ${JSON.stringify(value)}`);
  }
  return value;
}

function extractWorkspaceCwd(externalItems: JsonObject[]) {
  let cwd = "";
  for (const item of externalItems) {
    if (item.type !== "message" || item.role !== "user") continue;
    const match = codexMessageText(item).match(/<cwd>([\s\S]*?)<\/cwd>/i);
    if (match?.[1]?.trim()) cwd = match[1].trim();
  }
  return cwd;
}

function fileLines(value: unknown) {
  const lines = String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

function sequenceMatchesAt(
  haystack: string[],
  needle: string[],
  start: number,
) {
  if (start < 0 || start + needle.length > haystack.length) return false;
  return needle.every((line, index) => haystack[start + index] === line);
}

function findSequenceStarts(haystack: string[], needle: string[]) {
  if (needle.length === 0) return [];
  const starts: number[] = [];
  for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    if (sequenceMatchesAt(haystack, needle, index)) starts.push(index);
  }
  return starts;
}

function chooseUniqueOccurrence(
  lines: string[],
  oldLines: string[],
  before: string[],
  after: string[],
) {
  const starts = findSequenceStarts(lines, oldLines);
  if (starts.length === 1) return { status: "unique", start: starts[0], count: 1 };
  if (starts.length === 0) return { status: "missing", start: null, count: 0 };
  const narrowed = starts.filter((start) => {
    const beforePart = before.slice(-Math.min(before.length, start));
    const end = start + oldLines.length;
    const afterPart = after.slice(0, Math.min(after.length, lines.length - end));
    return (
      sequenceMatchesAt(lines, beforePart, start - beforePart.length) &&
      sequenceMatchesAt(lines, afterPart, end)
    );
  });
  if (narrowed.length === 1) {
    return {
      status: "unique-with-hints",
      start: narrowed[0],
      count: starts.length,
    };
  }
  return {
    status: "ambiguous",
    start: null,
    count: starts.length,
    narrowedCount: narrowed.length,
  };
}

function resolvePreflightPath(workspaceCwd: string, filePath: string) {
  if (!workspaceCwd) return null;
  // A deployed bridge cannot see the Codex client's workspace. It must also
  // never interpret client-supplied <cwd> as permission to inspect Vercel's
  // own filesystem. Local bridge runs retain the source adapter's preflight.
  const preflightSetting =
    process.env.GEMINI_ENABLE_LOCAL_PATCH_PREFLIGHT?.trim().toLowerCase();
  if (
    preflightSetting === "false" ||
    (process.env.VERCEL && preflightSetting !== "true")
  ) {
    return null;
  }
  const root = path.resolve(/*turbopackIgnore: true*/ workspaceCwd);
  const candidate = path.isAbsolute(filePath)
    ? path.resolve(/*turbopackIgnore: true*/ filePath)
    : path.resolve(root, filePath);
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return candidate;
}

function stabilizePureInsertion(lines: string[], hunk: JsonObject) {
  const before = splitLogicalLines(hunk.before);
  const after = splitLogicalLines(hunk.after);
  const newLines = splitLogicalLines(hunk.new);
  if (before.length > 0) {
    const starts = findSequenceStarts(lines, before);
    if (starts.length === 1) {
      const pivotIndex = starts[0] + before.length - 1;
      const pivot = lines[pivotIndex];
      return {
        status: "insertion-via-before",
        hunk: {
          anchor: "",
          before: [],
          old: [pivot],
          new: [pivot, ...newLines],
          after: lines.slice(pivotIndex + 1, pivotIndex + 2),
          end_of_file: false,
        },
      };
    }
  }
  if (after.length > 0) {
    const starts = findSequenceStarts(lines, after);
    if (starts.length === 1) {
      const pivotIndex = starts[0];
      const pivot = lines[pivotIndex];
      return {
        status: "insertion-via-after",
        hunk: {
          anchor: "",
          before: lines.slice(Math.max(0, pivotIndex - 1), pivotIndex),
          old: [pivot],
          new: [...newLines, pivot],
          after: [],
          end_of_file: false,
        },
      };
    }
  }
  return { status: "unresolved-insertion", hunk };
}

async function stabilizeStructuredApplyPatch(
  input: unknown,
  state: GeminiSessionState,
) {
  if (!input || typeof input !== "object" || !Array.isArray((input as JsonObject).operations)) {
    return { input, diagnostics: [{ status: "invalid-structured-input" }] };
  }
  const stabilized = structuredClone(input) as JsonObject;
  const diagnostics: JsonObject[] = [];
  for (const operation of stabilized.operations) {
    if (!operation || String(operation.action).toLowerCase() !== "update") continue;
    const filePath = validateApplyPatchPath(operation.path);
    const absolutePath = resolvePreflightPath(state.workspaceCwd, filePath);
    if (!absolutePath) {
      diagnostics.push({ path: filePath, status: "preflight-skipped-no-workspace-path" });
      continue;
    }
    let currentText: string;
    try {
      currentText = await fs.readFile(
        /*turbopackIgnore: true*/ absolutePath,
        "utf8",
      );
    } catch (error) {
      diagnostics.push({
        path: filePath,
        status: "preflight-read-failed",
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const lines = fileLines(currentText);
    const hunks = Array.isArray(operation.hunks) ? operation.hunks : [];
    for (let index = 0; index < hunks.length; index += 1) {
      const hunk = hunks[index] ?? {};
      const oldLines = splitLogicalLines(hunk.old);
      const newLines = splitLogicalLines(hunk.new);
      const before = splitLogicalLines(hunk.before);
      const after = splitLogicalLines(hunk.after);
      if (oldLines.length === 0 && newLines.length > 0) {
        const insertion = stabilizePureInsertion(lines, hunk);
        if (insertion.status !== "unresolved-insertion") hunks[index] = insertion.hunk;
        diagnostics.push({ path: filePath, hunk: index, status: insertion.status });
        continue;
      }
      if (oldLines.length === 0) {
        diagnostics.push({ path: filePath, hunk: index, status: "preflight-skipped-empty-old" });
        continue;
      }
      const match = chooseUniqueOccurrence(lines, oldLines, before, after);
      if (
        (match.status === "unique" || match.status === "unique-with-hints") &&
        match.start != null
      ) {
        const afterStart = match.start + oldLines.length;
        hunks[index] = {
          anchor: "",
          before: lines.slice(Math.max(0, match.start - 1), match.start),
          old: oldLines,
          new: newLines,
          after: lines.slice(afterStart, Math.min(lines.length, afterStart + 1)),
          end_of_file:
            hunk.end_of_file === true && afterStart === lines.length,
        };
        diagnostics.push({
          path: filePath,
          hunk: index,
          status: "refreshed-current-context",
          originalMatchMode: match.status,
        });
      } else {
        diagnostics.push({
          path: filePath,
          hunk: index,
          status: match.status,
          occurrences: match.count,
          narrowedOccurrences: match.narrowedCount ?? null,
        });
      }
    }
  }
  return { input: stabilized, diagnostics };
}

export function renderStructuredApplyPatch(input: unknown) {
  if (!input || typeof input !== "object" || !Array.isArray((input as JsonObject).operations)) {
    throw new Error("Structured apply_patch input must contain operations[].");
  }
  const lines = ["*** Begin Patch"];
  for (const operation of (input as JsonObject).operations) {
    const action = String(operation.action ?? "").toLowerCase();
    const filePath = validateApplyPatchPath(operation.path);
    if (action === "add") {
      lines.push(`*** Add File: ${filePath}`);
      const contentLines = String(operation.content ?? "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .split("\n");
      if (contentLines.length > 1 && contentLines.at(-1) === "") contentLines.pop();
      if (contentLines.length === 0) contentLines.push("");
      for (const line of contentLines) lines.push(`+${line}`);
      continue;
    }
    if (action === "delete") {
      lines.push(`*** Delete File: ${filePath}`);
      continue;
    }
    if (action !== "update") {
      throw new Error(`Unsupported apply_patch action ${JSON.stringify(operation.action)}`);
    }
    lines.push(`*** Update File: ${filePath}`);
    if (operation.move_to) {
      lines.push(`*** Move to: ${validateApplyPatchPath(operation.move_to)}`);
    }
    const hunks = Array.isArray(operation.hunks) ? operation.hunks : [];
    if (!hunks.length) {
      throw new Error(`apply_patch update for ${filePath} must contain a hunk`);
    }
    for (const hunk of hunks) {
      const anchor = sanitizeApplyPatchAnchor(hunk.anchor);
      lines.push(anchor ? `@@ ${anchor}` : "@@");
      const before = splitLogicalLines(hunk.before);
      const oldLines = splitLogicalLines(hunk.old);
      const newLines = splitLogicalLines(hunk.new);
      const after = splitLogicalLines(hunk.after);
      if (![...before, ...oldLines, ...newLines, ...after].length) {
        throw new Error(`apply_patch hunk for ${filePath} is empty`);
      }
      for (const line of before) lines.push(` ${line}`);
      for (const line of oldLines) lines.push(`-${line}`);
      for (const line of newLines) lines.push(`+${line}`);
      for (const line of after) lines.push(` ${line}`);
      if (hunk.end_of_file === true) lines.push("*** End of File");
    }
  }
  lines.push("*** End Patch");
  return `${lines.join("\n")}\n`;
}

export function buildAiSdkTools(
  codexTools: unknown,
  state: GeminiSessionState,
) {
  const tools: Record<string, JsonObject> = {};
  const map: Record<string, ToolMapping> = {};
  const used = new Set<string>();

  function addFunction(options: {
    originalName: string;
    description?: string;
    parameters?: unknown;
    codexKind?: "function" | "custom";
    namespace?: string | null;
    rawCustom?: boolean;
    structuredApplyPatch?: boolean;
  }) {
    const modelName = uniqueToolName(
      options.namespace
        ? `${options.namespace}__${options.originalName}`
        : options.originalName,
      used,
    );
    const schema =
      options.parameters && typeof options.parameters === "object"
        ? options.parameters
        : { type: "object", properties: {}, additionalProperties: true };
    tools[modelName] = {
      description: options.description || options.originalName,
      inputSchema: jsonSchema(schema as Parameters<typeof jsonSchema>[0]),
    };
    map[modelName] = {
      originalName: options.originalName,
      modelToolName: modelName,
      codexKind: options.codexKind ?? "function",
      namespace: options.namespace ?? null,
      rawCustom: options.rawCustom,
      structuredApplyPatch: options.structuredApplyPatch,
    };
  }

  function addTool(tool: JsonObject, namespace: JsonObject | null = null) {
    if (tool.type === "function") {
      addFunction({
        originalName: String(tool.name),
        description: [namespace?.description, tool.description].filter(Boolean).join("\n\n"),
        parameters: tool.parameters,
        namespace: namespace ? String(namespace.name) : null,
      });
      return;
    }
    if (tool.type !== "custom") return;
    if (isApplyPatchTool(tool.name)) {
      addFunction({
        originalName: String(tool.name),
        description: [
          namespace?.description,
          tool.description,
          APPLY_PATCH_STRUCTURED_DESCRIPTION,
        ]
          .filter(Boolean)
          .join("\n\n"),
        parameters: APPLY_PATCH_STRUCTURED_SCHEMA,
        codexKind: "custom",
        namespace: namespace ? String(namespace.name) : null,
        structuredApplyPatch: true,
      });
      return;
    }
    const format = tool.format ?? {};
    addFunction({
      originalName: String(tool.name),
      description: [
        namespace?.description,
        tool.description,
        format.syntax ? `Syntax: ${format.syntax}` : "",
        format.definition ? `Definition:\n${format.definition}` : "",
        'Return the complete freeform tool payload in the "input" string.',
      ]
        .filter(Boolean)
        .join("\n\n"),
      parameters: {
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"],
        additionalProperties: false,
      },
      codexKind: "custom",
      namespace: namespace ? String(namespace.name) : null,
      rawCustom: true,
    });
  }

  for (const tool of Array.isArray(codexTools) ? codexTools : []) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type === "namespace" && Array.isArray(tool.tools)) {
      for (const inner of tool.tools) {
        if (inner && typeof inner === "object") addTool(inner, tool);
      }
    } else {
      addTool(tool);
    }
  }

  state.modelToolMap = map;
  return tools;
}

export function reasoningProviderOptions(body: JsonObject) {
  const effort = body.reasoning?.effort;
  if (!effort || effort === "provider-default") return undefined;
  const mapped =
    effort === "xhigh"
      ? "high"
      : ["minimal", "low", "medium", "high"].includes(effort)
        ? effort
        : undefined;
  if (!mapped) return undefined;
  return { google: { thinkingConfig: { thinkingLevel: mapped } } };
}

export function recursivelyHasThoughtSignature(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (
    Object.prototype.hasOwnProperty.call(value, "thoughtSignature") ||
    Object.prototype.hasOwnProperty.call(value, "thought_signature")
  ) {
    return true;
  }
  return Array.isArray(value)
    ? value.some(recursivelyHasThoughtSignature)
    : Object.values(value).some(recursivelyHasThoughtSignature);
}

export function usageToOpenAI(usage: JsonObject = {}) {
  const inputTokens = Number(usage.inputTokens ?? 0);
  const outputTokens = Number(usage.outputTokens ?? 0);
  const cacheReadTokens = Number(
    usage.inputTokenDetails?.cacheReadTokens ??
      usage.inputTokensDetails?.cacheReadTokens ??
      usage.cachedInputTokens ??
      0,
  );
  const reasoningTokens = Number(
    usage.outputTokenDetails?.reasoningTokens ??
      usage.outputTokensDetails?.reasoningTokens ??
      usage.reasoningTokens ??
      0,
  );
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: cacheReadTokens },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: reasoningTokens },
    total_tokens: Number(usage.totalTokens ?? inputTokens + outputTokens),
  };
}

export function accumulateUsage(
  state: GeminiSessionState,
  usage: ReturnType<typeof usageToOpenAI>,
) {
  state.cumulativeUsage.inputTokens += usage.input_tokens;
  state.cumulativeUsage.cacheReadTokens += usage.input_tokens_details.cached_tokens;
  state.cumulativeUsage.outputTokens += usage.output_tokens;
  state.cumulativeUsage.reasoningTokens += usage.output_tokens_details.reasoning_tokens;
}

export function extractCanonicalToolCalls(responseMessages: JsonObject[]) {
  const calls = new Map<string, CanonicalToolCall>();
  for (const message of responseMessages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part?.type !== "tool-call" || !part.toolCallId) continue;
      calls.set(part.toolCallId, {
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      });
    }
  }
  return [...calls.values()];
}

export function mergeToolCalls(
  authoritative: CanonicalToolCall[],
  streamed: CanonicalToolCall[],
) {
  const calls = new Map<string, CanonicalToolCall>();
  for (const call of authoritative) calls.set(call.toolCallId, call);
  for (const call of streamed) {
    if (!calls.has(call.toolCallId)) calls.set(call.toolCallId, call);
  }
  return [...calls.values()];
}

function ensureCallMapForToolCall(
  state: GeminiSessionState,
  call: CanonicalToolCall,
) {
  if (!call?.toolCallId || state.callMap[call.toolCallId]) return;
  state.callMap[call.toolCallId] = {
    modelToolName: call.toolName,
    originalName: call.toolName,
    codexKind: "function",
    namespace: null,
    structuredApplyPatch: false,
  };
}

function toolResultIdsFromMessage(message: JsonObject) {
  const ids = new Set<string>();
  if (message?.role !== "tool" || !Array.isArray(message.content)) return ids;
  for (const part of message.content) {
    if (
      (part?.type === "tool-result" || part?.type === "tool-error") &&
      part.toolCallId
    ) {
      ids.add(part.toolCallId);
    }
  }
  return ids;
}

function assistantToolCallsFromMessage(message: JsonObject) {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content
    .filter((part: JsonObject) => part?.type === "tool-call" && part.toolCallId)
    .map((part: JsonObject) => ({
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      input: part.input,
    })) as CanonicalToolCall[];
}

function makeSyntheticMissingToolOutput(callId: string): JsonObject {
  return {
    type: "function_call_output",
    call_id: callId,
    output:
      "[canonical bridge recovery] Codex started another model turn without returning a result for this tool call. The tool may have been interrupted, rejected, or its result may have been lost. Do not assume any side effect succeeded; inspect current state before retrying.",
  };
}

export function ensureCurrentState(state: GeminiSessionState) {
  // Persisted v1.0-v1.2 bridge states predate the two-phase pending turn.
  if (!("pendingTurn" in (state as object))) {
    (state as unknown as { pendingTurn: null }).pendingTurn = null;
  }
  if (!Number.isFinite(state.legacyHealCount)) state.legacyHealCount = 0;
  const healed: string[] = [];
  for (let index = 0; index < state.messages.length; index += 1) {
    const calls = assistantToolCallsFromMessage(state.messages[index]);
    if (!calls.length) continue;
    const next = state.messages[index + 1];
    const resultIds = toolResultIdsFromMessage(next);
    const missing = calls.filter((call) => !resultIds.has(call.toolCallId));
    if (!missing.length) continue;
    for (const call of missing) ensureCallMapForToolCall(state, call);
    const syntheticParts = missing.map((call) => ({
      type: "tool-result",
      toolCallId: call.toolCallId,
      toolName: state.callMap[call.toolCallId].modelToolName,
      output: { type: "text", value: makeSyntheticMissingToolOutput(call.toolCallId).output },
    }));
    if (next?.role === "tool" && Array.isArray(next.content)) {
      next.content.push(...syntheticParts);
    } else {
      state.messages.splice(index + 1, 0, { role: "tool", content: syntheticParts });
      index += 1;
    }
    healed.push(...missing.map((call) => call.toolCallId));
  }
  state.legacyHealCount += healed.length;
  return healed;
}

function toolOutputCallId(item: JsonObject) {
  return item.call_id ?? item.tool_call_id ?? null;
}

function makeToolResultMessage(
  toolOutputs: JsonObject[],
  state: GeminiSessionState,
): JsonObject | null {
  const content: JsonObject[] = [];
  for (const item of toolOutputs) {
    const callId = toolOutputCallId(item);
    const mapping = callId ? state.callMap[callId] : null;
    if (!callId || !mapping) {
      throw new Error(
        `Cannot map tool output call_id=${callId ?? "<missing>"}. The Gemini bridge session may have been lost or rebased while a tool call was outstanding.`,
      );
    }
    content.push({
      type: "tool-result",
      toolCallId: callId,
      toolName: mapping.modelToolName,
      output: { type: "text", value: parseToolOutputValue(item) },
    });
  }
  return content.length ? { role: "tool", content } : null;
}

function commitPendingTurn(state: GeminiSessionState, body: JsonObject) {
  const pending = state.pendingTurn;
  if (!pending) {
    return { hadPending: false, resolvedCallIds: [], actualCallIds: [], synthesizedCallIds: [] };
  }
  const calls = pending.toolCalls?.length
    ? pending.toolCalls
    : extractCanonicalToolCalls(pending.responseMessages);
  for (const call of calls) ensureCallMapForToolCall(state, call);
  const provided = new Map<string, JsonObject>();
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (!item || typeof item !== "object" || !isToolOutput(item)) continue;
    const callId = toolOutputCallId(item);
    if (callId) provided.set(callId, item);
  }
  const outputs: JsonObject[] = [];
  const actualCallIds: string[] = [];
  const synthesizedCallIds: string[] = [];
  for (const call of calls) {
    const actual = provided.get(call.toolCallId);
    if (actual) {
      outputs.push(actual);
      actualCallIds.push(call.toolCallId);
    } else {
      outputs.push(makeSyntheticMissingToolOutput(call.toolCallId));
      synthesizedCallIds.push(call.toolCallId);
    }
  }
  state.messages.push(...structuredClone(pending.responseMessages));
  const toolMessage = makeToolResultMessage(outputs, state);
  if (toolMessage) state.messages.push(toolMessage);
  state.pendingTurn = null;
  return {
    hadPending: true,
    resolvedCallIds: calls.map((call) => call.toolCallId),
    actualCallIds,
    synthesizedCallIds,
  };
}

function seedCanonical(
  body: JsonObject,
  externalItems: JsonObject[],
  state: GeminiSessionState,
) {
  state.messages = [];
  state.callMap = {};
  state.pendingTurn = null;
  state.systemText = buildSystemText(body, externalItems);
  const cwd = extractWorkspaceCwd(externalItems);
  if (cwd) state.workspaceCwd = cwd;
  for (const item of externalItems) {
    if (item.type === "message" && item.role === "user") {
      const message = codexUserToModelMessage(item);
      if (message) state.messages.push(message);
    }
  }
}

export function prepareCanonicalState(
  body: JsonObject,
  state: GeminiSessionState,
) {
  const externalItems = externalSequence(body.input);
  const fingerprints = externalItems.map(normalizedExternalFingerprint);
  const pendingResolution = commitPendingTurn(state, body);
  const consumed = new Set(pendingResolution.resolvedCallIds);

  if (state.externalFingerprints.length === 0) {
    seedCanonical(body, externalItems, state);
    state.externalFingerprints = fingerprints;
    return { mode: "initial", deltaCount: externalItems.length, rebased: false, pendingResolution };
  }

  if (isPrefix(state.externalFingerprints, fingerprints)) {
    const delta = externalItems.slice(state.externalFingerprints.length);
    const cwd = extractWorkspaceCwd(externalItems);
    if (cwd) state.workspaceCwd = cwd;
    const systemText = buildSystemText(body, externalItems);
    if (systemText && systemText !== state.systemText) state.systemText = systemText;
    const toolOutputs: JsonObject[] = [];
    for (const item of delta) {
      if (item.type === "message" && item.role === "user") {
        const message = codexUserToModelMessage(item);
        if (message) state.messages.push(message);
      } else if (isToolOutput(item)) {
        const callId = toolOutputCallId(item);
        if (!callId || !consumed.has(callId)) toolOutputs.push(item);
      }
    }
    const toolMessage = makeToolResultMessage(toolOutputs, state);
    if (toolMessage) state.messages.push(toolMessage);
    state.externalFingerprints = fingerprints;
    return { mode: "append", deltaCount: delta.length, rebased: false, pendingResolution };
  }

  seedCanonical(body, externalItems, state);
  state.externalFingerprints = fingerprints;
  state.segment += 1;
  state.rebaseCount += 1;
  return { mode: "rebase", deltaCount: externalItems.length, rebased: true, pendingResolution };
}

function rawCustomInput(input: unknown) {
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && typeof (input as JsonObject).input === "string") {
    return (input as JsonObject).input;
  }
  return JSON.stringify(input ?? "");
}

export async function codexOutputItemForToolCall(
  toolCall: CanonicalToolCall,
  state: GeminiSessionState,
) {
  const mapping = state.modelToolMap[toolCall.toolName] ?? {
    originalName: toolCall.toolName,
    modelToolName: toolCall.toolName,
    codexKind: "function" as const,
    namespace: null,
  };
  state.callMap[toolCall.toolCallId] = {
    ...mapping,
    modelToolName: toolCall.toolName,
  };
  if (mapping.codexKind === "custom") {
    let input: string;
    if (mapping.structuredApplyPatch) {
      const stabilized = await stabilizeStructuredApplyPatch(toolCall.input, state);
      state.callMap[toolCall.toolCallId].patchPreflight = stabilized.diagnostics;
      input = renderStructuredApplyPatch(stabilized.input);
    } else {
      input = rawCustomInput(toolCall.input);
    }
    return {
      type: "custom_tool_call",
      call_id: toolCall.toolCallId,
      name: mapping.originalName,
      ...(mapping.namespace ? { namespace: mapping.namespace } : {}),
      input,
    };
  }
  return {
    type: "function_call",
    call_id: toolCall.toolCallId,
    name: mapping.originalName,
    ...(mapping.namespace ? { namespace: mapping.namespace } : {}),
    arguments: JSON.stringify(toolCall.input ?? {}),
  };
}
