/**
 * Environment configuration. Read lazily per request (server runtime only).
 * Never import this from client components.
 */

export const DEFAULT_OFFICIAL_BASE = "https://api.puter.com/puterai/openai/v1";
export const DEFAULT_DRIVER_BASE = "https://api.puter.com";

export type PuterMode = "driver" | "official";

export interface GatewayConfig {
  puterApiKey: string | null;
  puterApiBase: string;
  puterMode: PuterMode;
  gatewayApiKey: string | null;
  timeoutMs: number;
}

export function getConfig(): GatewayConfig {
  const mode = (process.env.PUTER_MODE || "driver").toLowerCase() as PuterMode;
  const timeout = Number(process.env.PUTER_TIMEOUT_MS || 120000);

  return {
    puterApiKey: process.env.PUTER_API_KEY?.trim() || null,
    puterApiBase:
      process.env.PUTER_API_BASE?.replace(/\/+$/, "") ||
      (mode === "official" ? DEFAULT_OFFICIAL_BASE : DEFAULT_DRIVER_BASE),
    puterMode: mode === "official" ? "official" : "driver",
    gatewayApiKey: process.env.GATEWAY_API_KEY?.trim() || null,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 120000,
  };
}

/** Fail-fast helper: PUTER_API_KEY is required for any upstream call. */
export function requirePuterApiKey(): string {
  const cfg = getConfig();
  if (!cfg.puterApiKey) {
    throw new ApiKeyMissingError(
      "PUTER_API_KEY is not configured on the server. Set it in the environment and restart the gateway."
    );
  }
  return cfg.puterApiKey;
}

export class ApiKeyMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiKeyMissingError";
  }
}
