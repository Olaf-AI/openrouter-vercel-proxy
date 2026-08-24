# OpenRouter Vercel Proxy

一个可直接部署到 Vercel 的 Next.js + TypeScript 项目：

- 前端或 Codex 调用 `/api/v1/chat/completions` / `/api/v1/responses`
- 服务端转发到 OpenRouter
- 支持服务端 OpenRouter Key，也兼容客户端自带 OpenRouter Key（BYOK）
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

## Codex

将 Codex 自定义 provider 的 base URL 指向：

```text
https://your-domain.example/api/v1
```

provider 必须使用 Responses API，并将其 API key 设置为 `PROXY_API_KEY`。实际请求路径为
`POST /api/v1/responses`。部署后请确认 Vercel 中的两个密钥变量均已配置并重新部署。

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
