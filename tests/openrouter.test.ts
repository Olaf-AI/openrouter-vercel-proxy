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

test("logs an upstream error with useful details without consuming its body", async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const logLines: string[] = [];

  globalThis.fetch = async () =>
    Response.json(
      {
        error: {
          message: "Provider rejected sk-super-secret-key",
          code: 403,
          metadata: {
            provider_name: "Example Provider",
            api_key: "must-not-be-logged",
          },
        },
      },
      {
        status: 403,
        headers: { "x-request-id": "upstream-request-123" },
      },
    );
  console.error = (...args: unknown[]) => {
    logLines.push(args.map(String).join(" "));
  };

  try {
    const response = await callOpenRouter(
      "chat/completions",
      { model: "gpt-4o-mini", messages: [], stream: false },
      "sk-client-secret-key",
    );

    assert.equal(response.status, 403);
    assert.equal((await response.json() as { error: { code: number } }).error.code, 403);
    assert.equal(logLines.length, 1);
    assert.match(logLines[0], /external_api_error/);
    assert.match(logLines[0], /upstream-request-123/);
    assert.match(logLines[0], /Example Provider/);
    assert.match(logLines[0], /\[REDACTED/);
    assert.doesNotMatch(logLines[0], /must-not-be-logged/);
    assert.doesNotMatch(logLines[0], /sk-super-secret-key/);
    assert.doesNotMatch(logLines[0], /sk-client-secret-key/);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});

test("logs transport failures and rethrows them", async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const logLines: string[] = [];

  globalThis.fetch = async () => {
    throw new Error("connection timed out");
  };
  console.error = (...args: unknown[]) => {
    logLines.push(args.map(String).join(" "));
  };

  try {
    await assert.rejects(
      callOpenRouter("chat/completions", { model: "gpt-4o-mini" }, "test-key"),
      /connection timed out/,
    );
    assert.equal(logLines.length, 1);
    assert.match(logLines[0], /external_api_failure/);
    assert.match(logLines[0], /connection timed out/);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});
