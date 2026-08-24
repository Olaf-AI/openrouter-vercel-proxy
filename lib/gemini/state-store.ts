import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { GeminiSessionState } from "@/lib/gemini/types";

const globalState = globalThis as typeof globalThis & {
  __geminiCanonicalStates?: Map<string, GeminiSessionState>;
  __geminiCanonicalQueues?: Map<string, Promise<void>>;
};

const memoryStates =
  globalState.__geminiCanonicalStates ?? new Map<string, GeminiSessionState>();
const sessionQueues =
  globalState.__geminiCanonicalQueues ?? new Map<string, Promise<void>>();

globalState.__geminiCanonicalStates = memoryStates;
globalState.__geminiCanonicalQueues = sessionQueues;

const redisUrl = (
  process.env.GEMINI_REDIS_REST_URL ||
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_URL ||
  ""
).replace(/\/+$/, "");

const redisToken =
  process.env.GEMINI_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  "";

const stateTtlSeconds = positiveInteger(
  process.env.GEMINI_STATE_TTL_SECONDS,
  60 * 60 * 24 * 7,
);
const lockTtlSeconds = positiveInteger(
  process.env.GEMINI_LOCK_TTL_SECONDS,
  300,
);
const lockWaitMs = positiveInteger(process.env.GEMINI_LOCK_WAIT_MS, 15_000);

const stateDirectory = path.resolve(
  /*turbopackIgnore: true*/
  process.env.GEMINI_STATE_DIR ||
    (process.env.VERCEL ? path.join(os.tmpdir(), "gemini-canonical-state") : ".gemini-canonical-state"),
);

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function digest(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stateKey(sessionKey: string) {
  return `codex-gemini:state:${digest(sessionKey)}`;
}

function lockKey(sessionKey: string) {
  return `codex-gemini:lock:${digest(sessionKey)}`;
}

function stateFile(sessionKey: string) {
  return path.join(
    /*turbopackIgnore: true*/ stateDirectory,
    `${digest(sessionKey).slice(0, 24)}.json`,
  );
}

function redisEnabled() {
  return Boolean(redisUrl && redisToken);
}

async function redisCommand(command: unknown[]) {
  const response = await fetch(redisUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${redisToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(
      `Gemini Redis command failed (${response.status}): ${await response.text()}`,
    );
  }

  const payload = (await response.json()) as {
    result?: unknown;
    error?: string;
  };
  if (payload.error) throw new Error(`Gemini Redis error: ${payload.error}`);
  return payload.result;
}

async function loadRedisState(sessionKey: string) {
  const value = await redisCommand(["GET", stateKey(sessionKey)]);
  if (typeof value !== "string" || !value) return null;
  return JSON.parse(value) as GeminiSessionState;
}

async function saveRedisState(state: GeminiSessionState) {
  await redisCommand([
    "SET",
    stateKey(state.sessionKey),
    JSON.stringify(state),
    "EX",
    stateTtlSeconds,
  ]);
}

async function loadFileState(sessionKey: string) {
  try {
    return JSON.parse(
      await fs.readFile(stateFile(sessionKey), "utf8"),
    ) as GeminiSessionState;
  } catch {
    return null;
  }
}

async function saveFileState(state: GeminiSessionState) {
  await fs.mkdir(stateDirectory, { recursive: true });
  const file = stateFile(state.sessionKey);
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(state), "utf8");
  await fs.rename(temporary, file);
}

export function createFreshState(
  sessionKey: string,
  model: string,
): GeminiSessionState {
  const now = new Date().toISOString();
  return {
    version: 1,
    sessionKey,
    model,
    createdAt: now,
    updatedAt: now,
    messages: [],
    systemText: "",
    workspaceCwd: "",
    externalFingerprints: [],
    callMap: {},
    pendingTurn: null,
    legacyHealCount: 0,
    modelToolMap: {},
    requestCount: 0,
    segment: 1,
    rebaseCount: 0,
    cumulativeUsage: {
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    },
  };
}

export async function loadState(sessionKey: string, model: string) {
  if (redisEnabled()) {
    const remote = await loadRedisState(sessionKey);
    if (remote) return remote;

    // Redis is the source of truth in distributed deployments. Do not revive
    // an expired/deleted remote session from one warm instance's memory.
    return createFreshState(sessionKey, model);
  }

  const cached = memoryStates.get(sessionKey);
  if (cached) return cached;

  if (!redisEnabled()) {
    const fileState = await loadFileState(sessionKey);
    if (fileState) {
      memoryStates.set(sessionKey, fileState);
      return fileState;
    }
  }

  const state = createFreshState(sessionKey, model);
  memoryStates.set(sessionKey, state);
  return state;
}

export async function saveState(state: GeminiSessionState) {
  state.updatedAt = new Date().toISOString();
  if (redisEnabled()) {
    await saveRedisState(state);
  } else {
    memoryStates.set(state.sessionKey, state);
    await saveFileState(state);
  }
}

async function acquireRedisLock(sessionKey: string) {
  const key = lockKey(sessionKey);
  const token = crypto.randomUUID();
  const deadline = Date.now() + lockWaitMs;

  while (Date.now() < deadline) {
    const result = await redisCommand([
      "SET",
      key,
      token,
      "NX",
      "EX",
      lockTtlSeconds,
    ]);
    if (result === "OK") return { key, token };
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error(
    "Timed out waiting for another Gemini request in the same Codex session.",
  );
}

async function releaseRedisLock(lock: { key: string; token: string }) {
  const script =
    'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
  await redisCommand(["EVAL", script, "1", lock.key, lock.token]);
}

async function withLocalLock<T>(sessionKey: string, fn: () => Promise<T>) {
  const previous = sessionQueues.get(sessionKey) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => gate);
  sessionQueues.set(sessionKey, queued);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (sessionQueues.get(sessionKey) === queued) {
      sessionQueues.delete(sessionKey);
    }
  }
}

export async function withSessionLock<T>(
  sessionKey: string,
  fn: () => Promise<T>,
) {
  return withLocalLock(sessionKey, async () => {
    if (!redisEnabled()) return fn();
    const lock = await acquireRedisLock(sessionKey);
    try {
      return await fn();
    } finally {
      await releaseRedisLock(lock).catch((error) => {
        console.error("Failed to release Gemini session lock", error);
      });
    }
  });
}

export function stateBackend() {
  return redisEnabled()
    ? "redis-rest"
    : process.env.VERCEL
      ? "ephemeral-file"
      : "local-file";
}

export function isDurableStateConfigured() {
  return redisEnabled();
}
