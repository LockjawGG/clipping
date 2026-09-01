import { existsSync } from "node:fs";

import { readJson, route } from "@/lib/api/http.ts";
import { getSettings, updateSettings } from "@/lib/api/settings.ts";
import { fastWhisperCppModel } from "@/lib/transcription/whisper-cpp.ts";
import { db } from "@/lib/db.ts";
import { env } from "@/lib/env.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Whether the "fast" transcription quality will use the compact model on THIS
 * install. The zip build ships it; the single-exe build cannot fit it, and
 * there fast means a lighter pass over the full model. Computed, not stored —
 * the UI uses it to describe fast honestly instead of guessing.
 */
function fastUsesSmallModel(): boolean {
  if (env.TRANSCRIPTION_PROVIDER !== "whisper-cpp") return false;
  const configured = process.env.WHISPER_CPP_MODEL;
  return !!configured && fastWhisperCppModel(configured, existsSync) !== null;
}

/** GET /api/settings — the user's Settings-tab values, defaults filled in. */
export const GET = route(async () => {
  const userId = await requireUserId();
  return Response.json({ ...(await getSettings(db, userId)), fastUsesSmallModel: fastUsesSmallModel() });
});

/** PUT /api/settings — patch any subset; returns the full result. */
export const PUT = route(async (req: Request) => {
  const userId = await requireUserId();
  return Response.json({
    ...(await updateSettings(db, userId, await readJson(req))),
    fastUsesSmallModel: fastUsesSmallModel(),
  });
});
