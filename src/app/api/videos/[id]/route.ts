import { route } from "@/lib/api/http.ts";
import { videoService } from "@/lib/api/service.ts";
import { getVideoStatus } from "@/lib/api/videos.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/videos/:id — ingest status for polling. */
export const GET = route<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  return Response.json(await getVideoStatus(videoService(), id));
});
