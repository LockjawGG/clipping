import { readJson, route } from "@/lib/api/http.ts";
import { getSettings } from "@/lib/api/settings.ts";
import { db } from "@/lib/db.ts";
import { mediaProbe, videoService } from "@/lib/api/service.ts";
import { createVideosFromUrl } from "@/lib/api/videos.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

/** POST /api/videos/from-url — ingest a link; a playlist link ingests every entry. */
export const POST = route(async (req: Request) => {
  const userId = await requireUserId();
  const prefs = await getSettings(db, userId);
  const result = await createVideosFromUrl(videoService(userId), mediaProbe(), await readJson(req), prefs.playlistMax);
  return Response.json(result, { status: 202 });
});
