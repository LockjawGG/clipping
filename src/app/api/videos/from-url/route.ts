import { readJson, route } from "@/lib/api/http.ts";
import { env } from "@/lib/env.ts";
import { mediaProbe, videoService } from "@/lib/api/service.ts";
import { createVideosFromUrl } from "@/lib/api/videos.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

/** POST /api/videos/from-url — ingest a link; a playlist link ingests every entry. */
export const POST = route(async (req: Request) => {
  const userId = await requireUserId();
  const result = await createVideosFromUrl(videoService(userId), mediaProbe(), await readJson(req), env.PLAYLIST_MAX);
  return Response.json(result, { status: 202 });
});
