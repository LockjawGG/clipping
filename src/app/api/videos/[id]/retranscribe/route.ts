import { route } from "@/lib/api/http.ts";
import { videoService } from "@/lib/api/service.ts";
import { retranscribeVideo } from "@/lib/api/videos.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/videos/:id/retranscribe — re-run transcription with the current project terms. */
export const POST = route<Ctx>(async (_req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await retranscribeVideo(videoService(userId), id));
});
