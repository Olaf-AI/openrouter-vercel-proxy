import assert from "node:assert/strict";
import test from "node:test";

import { callOpenRouter, normalizeOpenRouterModel } from "../lib/openrouter";

test("adds the OpenAI namespace to legacy OpenAI model names", () => {
  assert.equal(normalizeOpenRouterModel("gpt-4o-mini"), "openai/gpt-4o-mini");
  assert.equal(normalizeOpenRouterModel("o3-mini"), "openai/o3-mini");
  assert.equal(
    normalizeOpenRouterModel("text-embedding-3-small"),
    "openai/text-embedding-3-small",
  );
});

test("keeps provider-qualified and unknown model names unchanged", () => {
  assert.equal(
    normalizeOpenRouterModel("deepseek/deepseek-chat"),
    "deepseek/deepseek-chat",
  );
  assert.equal(normalizeOpenRouterModel("custom-model"), "custom-model");
});

test("forwards multimodal and structured-output fields without dropping them", async () => {
  const originalFetch = globalThis.fetch;
  let forwardedBody: Record<string, unknown> | undefined;

  globalThis.fetch = async (_input, init) => {
    forwardedBody = JSON.parse(String(init?.body));
    return new Response("{}", { status: 200 });
  };

  try {
    await callOpenRouter(
      "chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe this image" },
              { type: "image_url", image_url: { url: "https://example.test/a.jpg" } },
            ],
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "result", schema: { type: "object" } },
        },
      },
      "test-key",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(forwardedBody?.model, "openai/gpt-4o-mini");
  assert.ok(Array.isArray(forwardedBody?.messages));
  assert.deepEqual(
    (forwardedBody?.response_format as Record<string, unknown>)?.type,
    "json_schema",
  );
});
