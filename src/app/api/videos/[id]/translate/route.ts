import { readJson, route } from "@/lib/api/http.ts";
import { videoService } from "@/lib/api/service.ts";
import { translateVideo } from "@/lib/api/videos.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/videos/:id/translate — build a translation of the transcript (English only). */
export const POST = route<Ctx>(async (req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await translateVideo(videoService(userId), id, await readJson(req)));
});
