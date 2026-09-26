import { ApiKeyMissingError, getConfig, requirePuterApiKey } from "@/lib/env";
import { upstreamErrorResponse, errorResponse } from "@/lib/errors";
import { checkClientAuth } from "@/lib/auth";
import {
  puterDriverChat,
  puterDriverChatStream,
  puterOfficialChat,
  puterOfficialChatStream,
  type ChatRequest,
} from "@/lib/puter";
import {
  makeCompletionId,
  makeToolCallId,
  normalizeFinishReason,
  nowEpoch,
  translateUsage,
  contentToString,
  createThinkSplitter,
  GATEWAY_VERSION,
} from "@/lib/openai";
import type { DriverStreamEvent, OpenAiChunkDelta, OpenAiMessage, ToolCall } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Maximum bytes we accept for a request body (1 MiB, same as OpenAI). */
const MAX_BODY_BYTES = 1024 * 1024;

export async function POST(req: Request): Promise<Response> {
  const authErr = checkClientAuth(req);
  if (authErr) return authErr;

  let body: ChatRequest;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) {
      return errorResponse("Request body too large.", "invalid_request_error", "body_too_large", 413);
    }
    body = JSON.parse(raw) as ChatRequest;
  } catch {
    return errorResponse("Invalid JSON in request body.", "invalid_request_error", "invalid_json", 400);
  }

  // ---- Validation ---------------------------------------------------------
  if (!body || typeof body !== "object") {
    return errorResponse("Request body must be a JSON object.", "invalid_request_error", null, 400);
  }
  if (typeof body.model !== "string" || !body.model.trim()) {
    return errorResponse("Missing required parameter: 'model'.", "invalid_request_error", "missing_model", 400);
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return errorResponse("Missing required parameter: 'messages'.", "invalid_request_error", "missing_messages", 400);
  }
  for (const m of body.messages) {
    if (!m || typeof m !== "object" || typeof m.role !== "string") {
      return errorResponse("Each message must be an object with a 'role' string.", "invalid_request_error", "bad_message", 400);
    }
  }

  const wantStream = body.stream === true;

  try {
    const apiKey = requirePuterApiKey();
    const cfg = getConfig();

    if (cfg.puterMode === "official") {
      // Official endpoint already speaks OpenAI — pass through.
      const upstream = wantStream ? await puterOfficialChatStream(body, apiKey) : await puterOfficialChat(body, apiKey);
      return new Response(upstream.body, {
        status: 200,
        headers: sseHeaders(wantStream),
      });
    }

    // ---- Free user-pays driver path --------------------------------------
    if (wantStream) {
      const upstream = await puterDriverChatStream(body, apiKey);
      return streamFromDriver(upstream, body.model);
    }

    const result = await puterDriverChat(body, apiKey);
    const msg = result.message;
    const toolCalls = normalizeToolCalls(msg.tool_calls);
    let content = contentToString(msg.content);
    // Reasoning models emit thinking either as a separate upstream field or
    // inline in <think>…</think>; normalize both into message.reasoning.
    let reasoning = typeof msg.reasoning === "string" ? msg.reasoning : null;
    if (content.includes("<think>")) {
      const parts = createThinkSplitter()(content);
      content = parts.content;
      reasoning = reasoning ? `${reasoning}${parts.reasoning}` : parts.reasoning || null;
    }

    const message: OpenAiMessage = { role: "assistant", content: content || null };
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    if (reasoning) message.reasoning = reasoning;

    return Response.json(
      {
        id: makeCompletionId(),
        object: "chat.completion",
        created: nowEpoch(),
        model: body.model,
        choices: [
          {
            index: 0,
            message,
            logprobs: null,
            finish_reason: normalizeFinishReason(result.finish_reason, toolCalls.length > 0),
          },
        ],
        usage: translateUsage(result.usage),
      },
      { status: 200, headers: { "X-Gateway-Version": GATEWAY_VERSION } }
    );
  } catch (err) {
    if (err instanceof ApiKeyMissingError) return upstreamErrorResponse(err);
    if (err instanceof SyntaxError) {
      return errorResponse("Invalid JSON in request body.", "invalid_request_error", "invalid_json", 400);
    }
    return upstreamErrorResponse(err);
  }
}

function sseHeaders(isStream: boolean): Record<string, string> {
  return isStream
    ? {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Gateway-Version": GATEWAY_VERSION,
      }
    : { "Content-Type": "application/json", "X-Gateway-Version": GATEWAY_VERSION };
}

/** Coerce upstream tool_calls into the OpenAI shape, assigning ids if missing. */
function normalizeToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((tc, i) => {
    const t = (tc ?? {}) as Record<string, unknown>;
    const fn = (t.function ?? {}) as Record<string, unknown>;
    return {
      id: typeof t.id === "string" && t.id ? t.id : makeToolCallId(),
      type: "function" as const,
      function: {
        name: String(fn.name ?? t.name ?? ""),
        arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? t.input ?? {}),
      },
      ...(i === -1 ? {} : {}),
    };
  });
}

/**
 * Wrap the Puter NDJSON stream into OpenAI chat.completion.chunk SSE.
 * Forwarded incrementally — nothing is buffered.
 *
 * Upstream event types (probed live):
 *   {"type":"text","text":"..."}                       → delta.content / delta.reasoning
 *   {"type":"tool_use","id","name","input"}            → delta.tool_calls[0] fragments
 *   {"type":"usage","usage":{...}}                     → final usage chunk
 * <think>…</think> spans inside text are mapped to delta.reasoning.
 */
function streamFromDriver(upstream: Response, clientModel: string): Response {
  const id = makeCompletionId();
  const created = nowEpoch();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const splitThink = createThinkSplitter();

  const sse = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (delta: OpenAiChunkDelta, finish: string | null = null, extra?: Record<string, unknown>) => {
        const payload = {
          id,
          object: "chat.completion.chunk",
          created,
          model: clientModel,
          system_fingerprint: null,
          choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
          ...extra,
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      // First chunk: role announcement, matching OpenAI behavior.
      send({ role: "assistant", content: "" });

      let toolIndex = 0;
      let emittedFinish = "stop";
      let usage: unknown = null;
      const reader = upstream.body!.getReader();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let evt: DriverStreamEvent;
            try {
              evt = JSON.parse(trimmed) as DriverStreamEvent;
            } catch {
              continue; // skip malformed/keep-alive lines
            }
            if (evt.type === "text" && typeof (evt as { text?: unknown }).text === "string") {
              const { reasoning, content } = splitThink((evt as { text: string }).text);
              if (reasoning) send({ reasoning });
              if (content) send({ content });
            } else if (evt.type === "tool_use") {
              const t = evt as { id?: string; name?: string; input?: Record<string, unknown> };
              send({
                tool_calls: [
                  {
                    index: toolIndex,
                    id: t.id || makeToolCallId(),
                    type: "function",
                    function: {
                      name: t.name ?? "",
                      arguments: JSON.stringify(t.input ?? {}),
                    },
                  },
                ],
              });
              toolIndex++;
              emittedFinish = "tool_calls";
            } else if (evt.type === "usage") {
              usage = (evt as { usage?: unknown }).usage ?? null;
            }
          }
        }
      } catch (err) {
        console.error("[gateway] stream read error:", err);
      } finally {
        send({}, emittedFinish);
        send({}, null, { usage: translateUsage(usage) });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
    cancel(reason) {
      void upstream.body?.cancel(reason);
    },
  });

  return new Response(sse, {
    status: 200,
    headers: sseHeaders(true),
  });
}
