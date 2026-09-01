import { route } from "@/lib/api/http.ts";
import { getSettings } from "@/lib/api/settings.ts";
import { ollamaStatus, pickModel } from "@/lib/llm/ollama.ts";
import { db } from "@/lib/db.ts";
import { env } from "@/lib/env.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/assistant/status — is a local model there, and which would we use?
 *
 * The UI leans on this to be honest: with no Ollama the assistant renders as
 * an invitation to install it, never as a broken chat box.
 */
export const GET = route(async () => {
  const userId = await requireUserId();
  const prefs = await getSettings(db, userId);
  const status = await ollamaStatus({ baseUrl: env.OLLAMA_BASE_URL });
  return Response.json({
    available: status.available,
    models: status.models,
    model: pickModel(prefs.assistantModel || env.OLLAMA_MODEL, status.models),
  });
});
