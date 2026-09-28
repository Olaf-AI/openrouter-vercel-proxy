# OpenRouter Vercel Proxy

一个可直接部署到 Vercel 的 Next.js + TypeScript 项目：

- 前端或 Codex 调用 `/api/v1/chat/completions` / `/api/v1/responses`
- 后端服务可调用 `/api/v1/embeddings` / `/api/v1/moderations`
- 服务端转发到 OpenRouter
- 支持服务端 OpenRouter Key，也兼容客户端自带 OpenRouter Key（BYOK）
- 通过独立的 `/api/gemini/v1` Base URL 将 Codex Responses API 适配到 Gemini
- 可继续扩展鉴权、限流、日志

## 本地启动

```bash
npm install
cp .env.example .env.local
npm run dev
```

打开 http://localhost:3000

## 部署到 Vercel

1. 推到 GitHub
2. 在 Vercel 导入仓库
3. 配置环境变量：
   - `OPENROUTER_API_KEY`：服务端用于访问 OpenRouter 的真实密钥
   - `PROXY_API_KEY`：客户端访问本代理时使用的独立密钥；服务端密钥模式下必填
   - `OPENAI_MODERATION_API_KEY`：仅用于转发 OpenAI Moderation API
   - `OPENAI_MODERATION_BASE_URL`：可选，默认 `https://api.openai.com/v1`
   - `OPENROUTER_BASE_URL`
   - `OPENROUTER_APP_NAME`
   - `OPENROUTER_SITE_URL`
   - `DENY_ORIGINS`
   - `DENY_HOSTS`
   - `DENY_LOCALHOST`
   - `DEFAULT_MODEL`
4. 点击部署

服务端密钥模式必须同时配置 `OPENROUTER_API_KEY` 和 `PROXY_API_KEY`，避免部署成为
任何人都能消耗额度的公开代理。这样 Codex 只需要持有
`PROXY_API_KEY`，代理会在转发时替换为服务端的 `OPENROUTER_API_KEY`。如果两个变量
都不配置，代理仍兼容原来的 BYOK 模式，此时客户端 Bearer token 会直接传给 OpenRouter。

聊天接口会保留多模态消息和 `response_format` 等 OpenAI-compatible 参数并原样转发；
历史的 `gpt-*`、`o1-*`、`o3-*`、`o4-*` 和 `text-embedding-*` 短模型名会自动补上
`openai/` 前缀。Moderation 不经过 OpenRouter，而是使用独立的
`OPENAI_MODERATION_API_KEY` 调用 OpenAI Moderation API。

## Vercel 错误日志

OpenRouter、Vercel AI Gateway 或 OpenAI Moderation 返回 4xx/5xx 时，代理会在
Vercel Runtime Logs 写入一条 `External API error` 结构化日志。网络连接失败则记录
`external_api_failure`。可以在 Vercel 项目的 **Logs** 页面搜索：

```text
external_api_error
```

每条日志包含 `provider`、`path`、`model`、`status`、`durationMs`、
`proxyRequestId`、上游 `upstreamRequestId` 和脱敏后的 `responseError`。例如：

```text
External API error {"event":"external_api_error","provider":"openrouter","path":"chat/completions","status":403,"responseError":{"body":{"message":"Provider rejected request","code":403}}}
```

请求正文和对话内容不会进入日志；Authorization、API key、token、cookie、secret 和
password 字段会被替换为 `[REDACTED]`，错误正文最多保留 8,000 个字符。

## Codex

将 Codex 自定义 provider 的 base URL 指向：

```text
https://your-domain.example/api/v1
```

provider 必须使用 Responses API，并将其 API key 设置为 `PROXY_API_KEY`。实际请求路径为
`POST /api/v1/responses`。部署后请确认 Vercel 中的两个密钥变量均已配置并重新部署。

## Gemini Canonical Bridge

Gemini 使用完全独立的 Base URL，不会经过或修改已有的 OpenRouter、Vercel Gateway 路由：

```text
https://your-domain.example/api/gemini/v1
```

Codex 实际请求 `POST /api/gemini/v1/responses`。健康检查位于
`GET /api/gemini/health`。

这不是简单透传。新端点会完成 `codex-gemini-canonical-bridge` 的核心转换：

- 把 Codex Responses 输入转换成 AI SDK 的 canonical `ModelMessage[]`
- 将 function、namespace、custom tool 转为 Gemini 可接受的函数 schema
- 将结构化的 `apply_patch` 调用确定性渲染回 Codex patch 文本
- 把 Gemini 流转换为 Codex 可消费的 Responses SSE 事件
- 原样保存 AI SDK 返回的 Gemini `thoughtSignature` provider metadata
- 工具轮次采用两阶段提交；签名 assistant 消息和全部工具结果始终成对进入历史
- Codex 压缩或重写历史时自动开启新的 canonical segment

服务端至少配置：

```text
GEMINI_AI_GATEWAY_API_KEY=your_ai_gateway_key
GEMINI_PROXY_API_KEY=your_client_facing_proxy_key
```

`GEMINI_AI_GATEWAY_API_KEY` 也可由 `AI_GATEWAY_API_KEY` 或 `VERCEL_API_KEY`
提供。`GEMINI_PROXY_API_KEY` 未设置时会复用原有的 `PROXY_API_KEY`，因此现有部署
可以继续用同一个客户端代理密钥，但 Base URL 仍然完全隔离。若服务端没有配置上游
key 且也没有代理 key，则仍支持把客户端 Bearer token 作为 AI Gateway BYOK key。

本地单进程会把 canonical 会话保存在 `.gemini-canonical-state`。Vercel 多实例部署必须
配置 Redis REST，才能在冷启动和实例切换后继续保留 Gemini 签名历史：

```text
GEMINI_REDIS_REST_URL=https://...
GEMINI_REDIS_REST_TOKEN=...
```

也会自动识别 `KV_REST_API_URL` / `KV_REST_API_TOKEN` 和
`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`。Redis 模式同时使用按会话的
分布式锁，避免同一 Codex 任务的并发请求交错写坏历史。不配置 Redis 时，Vercel 会回退
到 `/tmp` 临时状态，仅适合短期验证，不保证跨实例连续性。

`apply_patch` 的本地文件预检只在桥接器和 Codex 位于同一台可信机器时有意义。Vercel
默认禁用该文件读取；如在同机自托管且希望保留原适配器的上下文刷新，可显式设置
`GEMINI_ENABLE_LOCAL_PATCH_PREFLIGHT=true`。

Codex 配置示例（同时可使用项目根目录的 `model_catalog.gemini.json`）：

```toml
model = "google/gemini-3.7-flash"
model_provider = "gemini_canonical_bridge"
model_catalog_json = "/ABSOLUTE/PATH/TO/model_catalog.gemini.json"

[model_providers.gemini_canonical_bridge]
name = "Gemini Canonical Bridge"
base_url = "https://your-domain.example/api/gemini/v1"
env_key = "GEMINI_PROXY_API_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
supports_standalone_web_search = false
```

Gemini 适配依赖 AI SDK 7，需要 Node.js 22 或更高版本。Vercel 部署时请使用 Node.js 22。

Vercel AI Gateway 的逐请求密钥转发使用另一个入口：

```text
https://your-domain.example/api/vercel-gateway/v1
```

代理日志只记录 Vercel key 的 SHA-256 前 12 位指纹，不会记录原始 key。可在客户端计算
同样的指纹并与 Vercel Logs 中的 `keyFingerprint` 对比：

```bash
printf %s "$AI_GATEWAY_API_KEY" | sha256sum | cut -c1-12 # Linux
printf %s "$AI_GATEWAY_API_KEY" | shasum -a 256 | cut -c1-12 # macOS
```

## 调用示例

```ts
await fetch("https://your-domain.vercel.app/api/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: "Bearer YOUR_PROXY_API_KEY",
  },
  body: JSON.stringify({
    model: "openai/gpt-4o-mini",
    stream: false,
    messages: [{ role: "user", content: "你好" }],
  }),
});
```

Responses API 流式检查：

```bash
curl -N https://your-domain.vercel.app/api/v1/responses \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_PROXY_API_KEY' \
  -d '{
    "model": "deepseek/deepseek-v4-pro-0813",
    "input": "Call the healthcheck tool.",
    "tools": [{
      "type": "function",
      "name": "healthcheck",
      "description": "Check whether tool calling works",
      "parameters": {"type": "object", "properties": {}}
    }],
    "tool_choice": "required",
    "stream": true
  }'
```
