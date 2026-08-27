import { readJson, route } from "@/lib/api/http.ts";
import { videoService } from "@/lib/api/service.ts";
import { createVideoUpload } from "@/lib/api/videos.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

/** POST /api/videos — create the row and hand back a presigned upload URL. */
export const POST = route(async (req: Request) => {
  const userId = await requireUserId();
  const body = await readJson(req);
  const result = await createVideoUpload(videoService(userId), body);
  return Response.json(result, { status: 201 });
});
