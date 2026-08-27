import { route } from "@/lib/api/http.ts";
import { videoService } from "@/lib/api/service.ts";
import { confirmUpload } from "@/lib/api/videos.ts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/videos/:id/ingest — verify the upload landed, enqueue PROBE. */
export const POST = route<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  return Response.json(await confirmUpload(videoService(), id));
});
