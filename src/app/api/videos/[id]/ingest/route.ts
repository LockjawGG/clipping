import { route } from "@/lib/api/http.ts";
import { videoService } from "@/lib/api/service.ts";
import { confirmUpload } from "@/lib/api/videos.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/videos/:id/ingest — verify the upload landed, enqueue PROBE. */
export const POST = route<Ctx>(async (_req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await confirmUpload(videoService(userId), id));
});
