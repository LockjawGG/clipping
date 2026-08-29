import { readJson, route } from "@/lib/api/http.ts";
import { videoService } from "@/lib/api/service.ts";
import { deleteVideo, getVideoStatus, updateVideo } from "@/lib/api/videos.ts";
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

/** PATCH /api/videos/:id — move the video into another project. */
export const PATCH = route<Ctx>(async (req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await updateVideo(videoService(userId), id, await readJson(req)));
});

/** DELETE /api/videos/:id — remove the video and its clips/transcript/jobs. */
export const DELETE = route<Ctx>(async (_req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await deleteVideo(videoService(userId), id));
});
