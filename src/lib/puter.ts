import { getConfig, type GatewayConfig } from "./env";
import { UpstreamHttpError, parseUpstreamError } from "./errors";
import { resolveModel } from "./models";

/** OpenAI-style chat completion request, subset we translate. */
export interface ChatRequest {
  model: string;
  messages: Array<{
    role: string;
    content: unknown;
    tool_calls?: unknown;
    tool_call_id?: string;
    name?: string;
  }>;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  tools?: unknown;
  tool_choice?: unknown;
  response_format?: unknown;
  seed?: number;
  n?: number;
  reasoning_effort?: string;
  user?: string;
  [key: string]: unknown;
}

/**
 * Fields forwarded verbatim into driver args when present (probed live against
 * api.puter.com — all accepted by the openai-completion service).
 */
const PASS_THROUGH_ARGS = [
  "temperature",
  "top_p",
  "max_tokens",
  "tools",
  "tool_choice",
  "response_format",
  "seed",
  "reasoning_effort",
  "stop",
  "user",
] as const;

const TIMEOUT_ABORT_REASON = "gateway-timeout";

async function puterFetch(cfg: GatewayConfig, path: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(TIMEOUT_ABORT_REASON), cfg.timeoutMs);
  try {
    return await fetch(`${cfg.puterApiBase}${path}`, {
      ...init,
      signal: controller.signal,
      cache: "no-store",
    });
  } finally {
    clearTimeout(timer);
  }
}

function authHeaders(cfg: GatewayConfig, accept?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.puterApiKey ?? ""}`,
  };
  if (accept) headers.Accept = accept;
  return headers;
}

function buildDriverArgs(body: ChatRequest, stream: boolean): Record<string, unknown> {
  const args: Record<string, unknown> = {
    model: resolveModel(body.model),
    messages: body.messages.map((m) => {
      // Forward role/content plus tool-call bookkeeping fields verbatim.
      const out: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.tool_calls !== undefined) out.tool_calls = m.tool_calls;
      if (m.tool_call_id !== undefined) out.tool_call_id = m.tool_call_id;
      if (m.name !== undefined) out.name = m.name;
      return out;
    }),
    stream,
  };
  for (const key of PASS_THROUGH_ARGS) {
    if (body[key] !== undefined) args[key] = body[key];
  }
  return args;
}

function driverPayload(body: ChatRequest, stream: boolean): Record<string, unknown> {
  return {
    interface: "puter-chat-completion",
    method: "complete",
    args: buildDriverArgs(body, stream),
  };
}

/** Throw a normalized UpstreamHttpError if !res.ok. */
async function assertOk(res: Response): Promise<void> {
  if (!res.ok) throw await parseUpstreamError(res);
}

export interface DriverChatResult {
  message: Record<string, unknown>; // { role, content, tool_calls?, reasoning? }
  finish_reason: unknown;
  usage: unknown;
}

/**
 * Non-streaming chat via the free user-pays driver path.
 * Response shape (probed live):
 * { success, result: { message: {role, content, tool_calls?, reasoning?},
 *   finish_reason, usage: {prompt_tokens, completion_tokens, ...} } }
 */
export async function puterDriverChat(body: ChatRequest, apiKey: string): Promise<DriverChatResult> {
  const cfg = getConfig();
  const res = await puterFetch(cfg, "/drivers/call", {
    method: "POST",
    headers: authHeaders({ ...cfg, puterApiKey: apiKey }),
    body: JSON.stringify(driverPayload(body, false)),
  });
  await assertOk(res);
  const json = (await res.json()) as {
    success: boolean;
    result?: { message?: Record<string, unknown>; finish_reason?: unknown; usage?: unknown };
  };
  const result = json.result ?? {};
  return {
    message: result.message ?? { role: "assistant", content: "" },
    finish_reason: result.finish_reason ?? "stop",
    usage: result.usage ?? null,
  };
}

/**
 * Streaming chat via the driver path. Returns the raw NDJSON body stream.
 * Line shapes (probed live):
 *   {"type":"text","text":"..."}
 *   {"type":"tool_use","id":"call_...","name":"fn","input":{...},"text":""}
 *   {"type":"usage","usage":{...}}
 * Reasoning models may emit <think>...</think> inline in text chunks, and
 * non-streaming messages carry a separate `reasoning` field.
 */
export async function puterDriverChatStream(body: ChatRequest, apiKey: string): Promise<Response> {
  const cfg = getConfig();
  const res = await puterFetch(cfg, "/drivers/call", {
    method: "POST",
    headers: authHeaders({ ...cfg, puterApiKey: apiKey }, "text/event-stream"),
    body: JSON.stringify(driverPayload(body, true)),
  });
  await assertOk(res);
  if (!res.body) throw new UpstreamHttpError(502, "empty_stream", "Upstream returned an empty stream.");
  return res;
}

/**
 * Official OpenAI-compatible endpoint (paid accounts only). Used when
 * PUTER_MODE=official. Request/response bodies are passed through nearly
 * verbatim since Puter's endpoint already speaks OpenAI.
 */
export async function puterOfficialChat(body: ChatRequest, apiKey: string): Promise<Response> {
  const cfg = getConfig();
  const res = await puterFetch(cfg, "/chat/completions", {
    method: "POST",
    headers: authHeaders({ ...cfg, puterApiKey: apiKey }),
    body: JSON.stringify({ ...body, stream: false }),
  });
  await assertOk(res);
  return res;
}

export async function puterOfficialChatStream(body: ChatRequest, apiKey: string): Promise<Response> {
  const cfg = getConfig();
  const res = await puterFetch(cfg, "/chat/completions", {
    method: "POST",
    headers: authHeaders({ ...cfg, puterApiKey: apiKey }),
    body: JSON.stringify({ ...body, stream: true }),
  });
  await assertOk(res);
  if (!res.body) throw new UpstreamHttpError(502, "empty_stream", "Upstream returned an empty stream.");
  return res;
}
