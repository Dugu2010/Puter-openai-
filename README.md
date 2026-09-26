# Puter ⇄ OpenAI Gateway

An OpenAI-compatible API gateway backed by [Puter](https://puter.com). Point any OpenAI SDK or tool at this host and it talks to Puter's 1000+ models — GPT, Claude, Gemini, Grok, DeepSeek and more — with no code changes beyond the base URL.

**Works on free Puter accounts.** By default the gateway uses Puter's *user-pays driver path* (`POST /drivers/call` with `interface: "puter-chat-completion"`), the same mechanism the browser SDK uses, so no paid subscription is needed. Paid accounts can flip `PUTER_MODE=official` to use Puter's first-party OpenAI-compatible endpoint (`/puterai/openai/v1/...`).

## Endpoints

| Method | Path                   | Description                                                     |
| ------ | ---------------------- | --------------------------------------------------------------- |
| POST   | `/v1/chat/completions` | Chat completions — streaming (`stream: true`) and non-streaming |
| GET    | `/v1/models`           | OpenAI-style list of models this gateway exposes                |
| GET    | `/`                    | Landing page with endpoints, curl example, env vars             |

## Supported features

- **Streaming** — `"stream": true` returns OpenAI-format SSE (`chat.completion.chunk`, ends with `data: [DONE]`), forwarded incrementally.
- **Tool / function calling** — pass `tools` / `tool_choice`; responses carry `tool_calls` + `finish_reason: "tool_calls"` (parallel calls included); streaming exposes `delta.tool_calls` fragments with indexes; send results back as `role: "tool"` messages.
- **Reasoning models** — thinking is surfaced as `message.reasoning` / `delta.reasoning`; inline `<think>…</think>` blocks are extracted automatically.
- **Sampling & controls** — `temperature`, `top_p`, `max_tokens`, `stop`, `seed`, `response_format`, `reasoning_effort`, `user` pass through to the upstream model.
- **OpenAI error format** — upstream failures map to OpenAI-style error JSON with sensible status codes (401/402/429/502/504).

## Environment variables

| Variable          | Required | Default                  | Purpose                                                                       |
| ----------------- | -------- | ------------------------ | ----------------------------------------------------------------------------- |
| `PUTER_API_KEY`   | yes      | —                        | Puter auth token (puter.com/dashboard → Create token)                          |
| `PUTER_MODE`      | no       | `driver`                 | `driver` = free user-pays path; `official` = paid OpenAI-compatible endpoint   |
| `PUTER_API_BASE`  | no       | `https://api.puter.com`  | Override the upstream base URL                                                |
| `GATEWAY_API_KEY` | no       | (open access)            | When set, clients must send `Authorization: Bearer <GATEWAY_API_KEY>`         |
| `PUTER_TIMEOUT_MS`| no       | `120000`                 | Upstream timeout in ms                                                        |

## Scripts

```bash
npm install     # install dependencies
npm run dev     # development server (binds 0.0.0.0)
npm run build   # production build
npm run start   # production server (binds 0.0.0.0, honors $PORT)
npm run verify  # end-to-end checks against a mocked Puter upstream
```

## Deploy to Render

The repo ships with a `render.yaml` blueprint. Create a Render web service from this repo (Blueprint), set `PUTER_API_KEY` (and optionally `GATEWAY_API_KEY`) in the Render dashboard, and deploy. The service runs `npm install && npm run build` on deploy and `npm run start` at runtime. Streaming works out of the box on Render's Node server.

## Example

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hello!"}]}'
```

Tool calling:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "Weather in Tokyo?"}],
    "tools": [{"type": "function", "function": {"name": "get_weather", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}}}}],
    "tool_choice": "required"
  }'
```

Reasoning (DeepSeek R1):

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"infron:deepseek/deepseek-r1","messages":[{"role":"user","content":"What is 17*23?"}]}'
```
Read `choices[0].message.reasoning` for the thinking trace.

Streaming:

```bash
curl -N http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","stream":true,"messages":[{"role":"user","content":"Count to 3"}]}'
```

## Notes

- Model aliases live in `src/lib/models.ts` — one file, easy to extend. Vendor-qualified ids (`openai:openai/...`, `anthropic:anthropic/...`, …) pass through unchanged, and the full live catalog is at `https://api.puter.com/puterai/chat/models`.
- Upstream errors are translated to OpenAI-style error JSON with sensible status codes (401/403 auth, 402 subscription, 429 rate limit, 502/504 upstream failure/timeout).
