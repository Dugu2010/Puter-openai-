import { getConfig, type PuterMode } from "./env";

/**
 * Single source of truth for OpenAI-style aliases → Puter model ids.
 * Puter's live catalog uses vendor-qualified ids like `openai:openai/gpt-4o-mini`
 * (https://api.puter.com/puterai/chat/models). Extend ALIASES as models appear;
 * vendor-qualified ids not listed here are forwarded to Puter unchanged.
 */
export const ALIASES: Record<string, string> = {
  // OpenAI
  "gpt-4o": "openai:openai/gpt-4o-2024-11-20",
  "gpt-4o-mini": "openai:openai/gpt-4o-mini",
  "gpt-4.1": "openai:openai/gpt-4.1",
  "gpt-4.1-mini": "openai:openai/gpt-4.1-mini",
  "gpt-4.1-nano": "openai:openai/gpt-4.1-nano",
  "gpt-5": "openai:openai/gpt-5",
  "gpt-5-mini": "openai:openai/gpt-5-mini",
  "gpt-5-nano": "openai:openai/gpt-5-nano",
  "o1": "openai:openai/o1",
  "o3": "openai:openai/o3",
  "o3-mini": "openai:openai/o3-mini",
  "o4-mini": "openai:openai/o4-mini",
  // Anthropic
  "claude-sonnet-4-5": "anthropic:anthropic/claude-sonnet-4-5",
  "claude-sonnet-5": "anthropic:anthropic/claude-sonnet-5",
  "claude-opus-4-5": "anthropic:anthropic/claude-opus-4-5",
  "claude-opus-4-6": "anthropic:anthropic/claude-opus-4-6",
  "claude-haiku-4-5": "anthropic:anthropic/claude-haiku-4-5",
  // Google
  "gemini-2.5-flash": "google:google/gemini-2.5-flash",
  "gemini-2.5-pro": "google:google/gemini-2.5-pro",
  "gemini-3.1-flash-lite": "google:google/gemini-3.1-flash-lite",
  "gemini-3.5-flash": "google:google/gemini-3.5-flash",
  // xAI / DeepSeek
  "grok-4.3": "azure:x-ai/grok-4.3",
  "deepseek-chat": "deepseek:deepseek/deepseek-v4-flash",
  "deepseek-reasoner": "deepseek:deepseek/deepseek-v4-pro",
};

/** Ids starting with these vendor prefixes are forwarded to Puter unchanged. */
export const ALIAS_FALLBACK_PREFIXES = [
  "openai:",
  "anthropic:",
  "google:",
  "azure:",
  "infron:",
  "openrouter:",
  "deepseek:",
  "alibaba:",
  "together:",
  "minimax:",
  "moonshot:",
  "xai:",
  "meta:",
  "mistral:",
  "z-ai:",
  "byteplus:",
];

const MODEL_CREATED = 1704067200; // 2024-01-01; stable timestamp for /v1/models output

export function resolveModel(alias: string): string {
  const id = alias.trim();
  const mapped = ALIASES[id] ?? ALIASES[id.toLowerCase()];
  if (mapped) return mapped;
  // Vendor-qualified ids and bare names pass through — Puter routes bare
  // names to its default vendor for that model family.
  return id;
}

export function listModels(mode: PuterMode): Array<{
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}> {
  void mode;
  return Object.entries(ALIASES).map(([alias, target]) => ({
    id: alias,
    object: "model" as const,
    created: MODEL_CREATED,
    owned_by: target.split(":")[0],
  }));
}
