import { getConfig, requirePuterApiKey } from "@/lib/env";
import { upstreamErrorResponse } from "@/lib/errors";
import { listModels } from "@/lib/models";
import { checkClientAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const authErr = checkClientAuth(req);
  if (authErr) return authErr;

  try {
    requirePuterApiKey(); // fail fast even for the listing, matching plan semantics
    return Response.json({
      object: "list",
      data: listModels(getConfig().puterMode),
    });
  } catch (err) {
    return upstreamErrorResponse(err);
  }
}
