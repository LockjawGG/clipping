import { route } from "@/lib/api/http.ts";
import { videoService } from "@/lib/api/service.ts";
import { getVideoStatus } from "@/lib/api/videos.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/videos/:id — ingest status for polling. */
export const GET = route<Ctx>(async (_req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await getVideoStatus(videoService(userId), id));
});
