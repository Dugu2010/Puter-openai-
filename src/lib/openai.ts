export const GATEWAY_VERSION = "0.1.0";

/** OpenAI-style opaque completion id. */
export function makeCompletionId(): string {
  return `chatcmpl-${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

export function makeToolCallId(): string {
  return `call_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

export function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Translate a Puter driver-path usage object into OpenAI usage.
 * Puter: { prompt_tokens, completion_tokens, cached_tokens, usd_cents }
 */
export function translateUsage(usage: unknown): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  const u = (usage ?? {}) as Record<string, unknown>;
  const prompt = typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0;
  const completion = typeof u.completion_tokens === "number" ? u.completion_tokens : 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

const FINISH_REASONS = new Set(["stop", "length", "tool_calls", "content_filter", "function_call"]);

/** Map Puter/vendor finish reasons to OpenAI's closed set where possible. */
export function normalizeFinishReason(
  reason: unknown,
  hasToolCalls = false
): "stop" | "length" | "tool_calls" | "content_filter" | "function_call" {
  if (hasToolCalls) return "tool_calls";
  const r = String(reason ?? "stop");
  if (r === "end_turn") return "stop";
  if (r === "max_tokens" || r === "length") return "length";
  if (r === "tool_use" || r === "tool_calls") return "tool_calls";
  if (r === "refusal") return "content_filter";
  if (r === "function_call") return "function_call";
  return FINISH_REASONS.has(r) ? (r as "stop") : "stop";
}

/** Normalize message.content which may be a string or an array of blocks. */
export function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        const p = part as Record<string, unknown>;
        if (typeof p?.text === "string") return p.text;
        return "";
      })
      .join("");
  }
  return "";
}

/**
 * Split a text chunk into (reasoning, content) parts based on <think>...</think>
 * markers that reasoning models (DeepSeek R1 et al.) stream inline. Stateful:
 * call sequentially per stream. A leading <think> block is treated as reasoning
 * and stripped from content; OpenAI clients see it as delta.reasoning.
 */
export function createThinkSplitter() {
  let inThink = false;
  return (text: string): { reasoning: string; content: string } => {
    let reasoning = "";
    let content = "";
    let rest = text;
    while (rest.length > 0) {
      if (!inThink) {
        const open = rest.indexOf("<think>");
        if (open === -1) {
          content += rest;
          break;
        }
        content += rest.slice(0, open);
        rest = rest.slice(open + 7);
        inThink = true;
      } else {
        const close = rest.indexOf("</think>");
        if (close === -1) {
          reasoning += rest;
          break;
        }
        reasoning += rest.slice(0, close);
        rest = rest.slice(close + 8);
        inThink = false;
      }
    }
    return { reasoning, content };
  };
}
