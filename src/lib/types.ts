/**
 * Shared types for the OpenAI wire format pieces we emit or translate.
 */

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAiMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
  reasoning?: string | null;
}

export interface OpenAiChunkDelta {
  role?: "assistant";
  content?: string | null;
  tool_calls?: Array<Partial<ToolCall> & { index: number }>;
  reasoning?: string | null;
}

/** Puter driver-path NDJSON streaming event. */
export type DriverStreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown>; text?: string }
  | { type: "usage"; usage: Record<string, unknown> }
  | { type: string; [key: string]: unknown };
