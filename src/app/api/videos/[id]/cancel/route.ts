import { route } from "@/lib/api/http.ts";
import { videoService } from "@/lib/api/service.ts";
import { cancelVideo } from "@/lib/api/videos.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/videos/:id/cancel — stop a stuck or failing ingest. */
export const POST = route<Ctx>(async (_req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await cancelVideo(videoService(userId), id));
});
