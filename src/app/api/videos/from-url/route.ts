import { readJson, route } from "@/lib/api/http.ts";
import { videoService } from "@/lib/api/service.ts";
import { createVideoFromUrl } from "@/lib/api/videos.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

/** POST /api/videos/from-url — download a video from a link and start ingest. */
export const POST = route(async (req: Request) => {
  const userId = await requireUserId();
  const result = await createVideoFromUrl(videoService(userId), await readJson(req));
  return Response.json(result, { status: 202 });
});
