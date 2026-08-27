import { route } from "@/lib/api/http.ts";
import { clipService } from "@/lib/api/service.ts";
import { requestClipThumbnail } from "@/lib/api/clips.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

/** POST /api/clips/:id/thumbnail — (re)generate the clip's poster frame. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await requestClipThumbnail(clipService(userId), id), { status: 202 });
});
