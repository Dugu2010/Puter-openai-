import { ApiKeyMissingError } from "./env";

export interface OpenAiErrorBody {
  error: {
    message: string;
    type: string;
    code: string | null;
    param?: string | null;
  };
}

export function errorBody(
  message: string,
  type: string,
  code: string | null = null,
  status: number
): { status: number; body: OpenAiErrorBody } {
  return {
    status,
    body: { error: { message, type, code, param: null } },
  };
}

export function errorResponse(message: string, type: string, code: string | null, status: number): Response {
  const { body } = errorBody(message, type, code, status);
  return Response.json(body, { status });
}

/** Wrap a thrown upstream/network failure into an OpenAI-style error Response. */
export function upstreamErrorResponse(err: unknown): Response {
  if (err instanceof ApiKeyMissingError) {
    return errorResponse(err.message, "invalid_request_error", "missing_upstream_api_key", 500);
  }
  if (err instanceof UpstreamHttpError) return err.toResponse();
  if (err instanceof DOMException && err.name === "AbortError") {
    return errorResponse("Upstream request timed out.", "api_error", "upstream_timeout", 504);
  }
  const message = err instanceof Error ? err.message : "Unknown upstream failure";
  return errorResponse(`Upstream request failed: ${message}`, "api_error", "upstream_error", 502);
}

export class UpstreamHttpError extends Error {
  status: number;
  code: string | null;
  upstreamMessage: string;

  constructor(status: number, code: string | null, upstreamMessage: string) {
    super(upstreamMessage || `Upstream returned HTTP ${status}`);
    this.name = "UpstreamHttpError";
    this.status = status;
    this.code = code;
    this.upstreamMessage = upstreamMessage;
  }

  toResponse(): Response {
    const { status, code, upstreamMessage } = this;
    if (status === 401 || status === 403) {
      return errorResponse(
        `Puter rejected the configured API key (${status}): ${upstreamMessage}`,
        "authentication_error",
        "upstream_authentication_failed",
        401
      );
    }
    if (status === 402) {
      return errorResponse(
        `Puter returned 402 (subscription_required): ${upstreamMessage}. The official OpenAI-compatible endpoint requires a paid Puter plan — either set PUTER_MODE=driver (default, free user-pays path) or upgrade the Puter account.`,
        "invalid_request_error",
        "subscription_required",
        402
      );
    }
    if (status === 429) {
      return errorResponse(
        `Puter rate limit reached: ${upstreamMessage}`,
        "rate_limit_error",
        "upstream_rate_limited",
        429
      );
    }
    if (status >= 400 && status < 500) {
      return errorResponse(
        `Puter rejected the request (${status}): ${upstreamMessage}`,
        "invalid_request_error",
        code ?? "upstream_bad_request",
        400
      );
    }
    return errorResponse(
      `Puter upstream failure (${status}): ${upstreamMessage}`,
      "api_error",
      code ?? "upstream_error",
      502
    );
  }
}

/** Best-effort extraction of { error, message, code } from an upstream error payload. */
export async function parseUpstreamError(res: Response): Promise<UpstreamHttpError> {
  let message = "";
  let code: string | null = null;
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      if (typeof json.error === "string") message = json.error;
      else if (json.error && typeof json.error === "object") {
        const e = json.error as Record<string, unknown>;
        if (typeof e.message === "string") message = e.message;
        if (typeof e.code === "string") code = e.code;
      }
      if (!message && typeof json.message === "string") message = json.message;
      if (!code && typeof json.code === "string") code = json.code;
      if (!message) message = text.slice(0, 300);
    } catch {
      message = text.slice(0, 300);
    }
  } catch {
    message = `HTTP ${res.status}`;
  }
  return new UpstreamHttpError(res.status, code, message);
}
