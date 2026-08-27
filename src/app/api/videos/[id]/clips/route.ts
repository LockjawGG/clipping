import { readJson, route } from "@/lib/api/http.ts";
import { clipService } from "@/lib/api/service.ts";
import { createManualClip } from "@/lib/api/clips.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

/** POST /api/videos/:id/clips — add a manual clip, snapped to sentence bounds. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await createManualClip(clipService(userId), id, await readJson(req)), {
    status: 201,
  });
});
