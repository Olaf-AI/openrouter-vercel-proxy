import crypto from "node:crypto";

import { streamText } from "ai";

import {
  accumulateUsage,
  buildAiSdkTools,
  codexOutputItemForToolCall,
  ensureCurrentState,
  extractCanonicalToolCalls,
  getSessionKey,
  mergeToolCalls,
  prepareCanonicalState,
  reasoningProviderOptions,
  recursivelyHasThoughtSignature,
  sha256,
  shortSession,
  toolChoiceToAiSdk,
  usageToOpenAI,
} from "@/lib/gemini/canonical";
import { defaultGeminiModel, geminiModel } from "@/lib/gemini/gateway";
import { loadState, saveState, withSessionLock } from "@/lib/gemini/state-store";
import type { CanonicalToolCall, JsonObject } from "@/lib/gemini/types";

const encoder = new TextEncoder();

function eventBytes(event: JsonObject) {
  return encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function createGeminiResponsesStream(
  req: Request,
  body: JsonObject,
  gatewayApiKey: string,
) {
  const sessionKey = getSessionKey(req.headers, body);
  const sessionId = shortSession(sessionKey);
  const modelName =
    typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : defaultGeminiModel();
  let closed = false;
  const upstreamAbort = new AbortController();
  req.signal.addEventListener("abort", () => upstreamAbort.abort(), {
    once: true,
  });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (event: JsonObject) => {
        if (closed) return;
        try {
          controller.enqueue(eventBytes(event));
        } catch {
          closed = true;
        }
      };

      void withSessionLock(sessionKey, async () => {
        const state = await loadState(sessionKey, modelName);
        const healedCallIds = ensureCurrentState(state);
        state.requestCount += 1;

        const preparation = prepareCanonicalState(body, state);
        const aiTools = buildAiSdkTools(body.tools, state);
        const toolChoice = toolChoiceToAiSdk(body.tool_choice ?? "auto", state);
        await saveState(state);

        const responseId = `resp_cb_${crypto.randomUUID().replaceAll("-", "")}`;
        const messageId = `msg_cb_${crypto.randomUUID().replaceAll("-", "")}`;
        write({ type: "response.created", response: { id: responseId } });

        let textStarted = false;
        let accumulatedText = "";
        let toolCalls: CanonicalToolCall[] = [];
        let finalUsage: JsonObject | null = null;
        let streamError: unknown = null;

        try {
          const result = streamText({
            model: geminiModel(modelName, gatewayApiKey),
            system: state.systemText || undefined,
            messages: structuredClone(state.messages),
            tools: Object.keys(aiTools).length ? aiTools : undefined,
            toolChoice,
            maxOutputTokens:
              typeof body.max_output_tokens === "number"
                ? body.max_output_tokens
                : undefined,
            providerOptions: reasoningProviderOptions(body),
            abortSignal: upstreamAbort.signal,
            stopWhen: undefined,
          } as unknown as Parameters<typeof streamText>[0]);

          for await (const chunk of result.stream) {
            if (chunk.type === "text-start" && !textStarted) {
              textStarted = true;
              write({
                type: "response.output_item.added",
                item: {
                  type: "message",
                  role: "assistant",
                  id: messageId,
                  content: [{ type: "output_text", text: "" }],
                },
              });
              continue;
            }

            if (chunk.type === "text-delta") {
              if (!textStarted) {
                textStarted = true;
                write({
                  type: "response.output_item.added",
                  item: {
                    type: "message",
                    role: "assistant",
                    id: messageId,
                    content: [{ type: "output_text", text: "" }],
                  },
                });
              }
              accumulatedText += chunk.text;
              write({
                type: "response.output_text.delta",
                item_id: messageId,
                delta: chunk.text,
              });
              continue;
            }

            if (chunk.type === "tool-call") {
              toolCalls.push({
                toolCallId: chunk.toolCallId,
                toolName: chunk.toolName,
                input: chunk.input,
              });
              continue;
            }

            if (chunk.type === "finish") {
              finalUsage = (chunk.totalUsage ?? null) as JsonObject | null;
              continue;
            }

            if (chunk.type === "error") streamError = chunk.error;
          }

          if (streamError) throw streamError;

          const responseMessages = (await result.responseMessages) as JsonObject[];
          if (!Array.isArray(responseMessages) || responseMessages.length === 0) {
            throw new Error(
              "AI SDK did not expose responseMessages. Refusing to reconstruct Gemini history because that could drop thoughtSignature.",
            );
          }

          const canonicalToolCalls = extractCanonicalToolCalls(responseMessages);
          toolCalls = mergeToolCalls(canonicalToolCalls, toolCalls);

          if (textStarted || accumulatedText) {
            write({
              type: "response.output_item.done",
              item: {
                type: "message",
                role: "assistant",
                id: messageId,
                content: [{ type: "output_text", text: accumulatedText }],
              },
            });
          }

          const outwardToolItems = await Promise.all(
            toolCalls.map((call) => codexOutputItemForToolCall(call, state)),
          );

          if (toolCalls.length > 0) {
            state.pendingTurn = {
              createdAt: new Date().toISOString(),
              responseMessages: structuredClone(responseMessages),
              toolCalls: structuredClone(toolCalls),
            };
          } else {
            state.messages.push(...structuredClone(responseMessages));
          }

          // The exact signed Gemini history is durable before Codex is told to
          // execute any potentially side-effecting tool.
          await saveState(state);
          for (const item of outwardToolItems) {
            write({ type: "response.output_item.done", item });
          }

          if (!finalUsage) {
            try {
              const finalStep = await result.finalStep;
              finalUsage = (finalStep?.usage ?? null) as JsonObject | null;
            } catch {
              finalUsage = null;
            }
          }

          const usage = usageToOpenAI(finalUsage ?? {});
          accumulateUsage(state, usage);
          await saveState(state);

          console.info("Gemini canonical response", {
            session: sessionId,
            requestNo: state.requestCount,
            segment: state.segment,
            mode: preparation.mode,
            healedCallIds,
            model: modelName,
            toolCount: toolCalls.length,
            hasThoughtSignature: recursivelyHasThoughtSignature(responseMessages),
            canonicalMessageCount: state.messages.length,
            canonicalSha256: sha256(state.messages),
          });

          write({
            type: "response.completed",
            response: { id: responseId, model: modelName, usage },
          });
        } catch (error) {
          console.error("Gemini canonical bridge error", {
            session: sessionId,
            requestNo: state.requestCount,
            error,
          });
          write({
            type: "response.incomplete",
            response: {
              id: responseId,
              incomplete_details: { reason: errorMessage(error) },
            },
          });
        }
      })
        .catch((error) => {
          console.error("Gemini session failure", error);
          write({
            type: "response.incomplete",
            response: {
              id: `resp_cb_${crypto.randomUUID().replaceAll("-", "")}`,
              incomplete_details: { reason: errorMessage(error) },
            },
          });
        })
        .finally(() => {
          if (!closed) controller.close();
          closed = true;
        });
    },
    cancel() {
      closed = true;
      upstreamAbort.abort();
    },
  });

  return stream;
}
