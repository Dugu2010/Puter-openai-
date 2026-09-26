import { getConfig } from "@/lib/env";

/**
 * Client-to-gateway auth. When GATEWAY_API_KEY is set, /v1/* requires
 * `Authorization: Bearer <GATEWAY_API_KEY>`. When unset the gateway is open
 * (handy for local testing). Returns null when authorized, else an error Response.
 */
export function checkClientAuth(req: Request): Response | null {
  const cfg = getConfig();
  if (!cfg.gatewayApiKey) return null;

  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (token === cfg.gatewayApiKey) return null;

  const isMissing = token === "";
  return Response.json(
    {
      error: {
        message: isMissing
          ? "You didn't provide an API key. Include it as `Authorization: Bearer GATEWAY_API_KEY`."
          : "Incorrect API key provided.",
        type: isMissing ? "invalid_request_error" : "authentication_error",
        code: isMissing ? null : "invalid_api_key",
        param: null,
      },
    },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } }
  );
}
