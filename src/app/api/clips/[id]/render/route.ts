import { readJson, route } from "@/lib/api/http.ts";
import { clipService } from "@/lib/api/service.ts";
import { requestRender } from "@/lib/api/clips.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

/** POST /api/clips/:id/render — create a Render row and enqueue a RENDER job. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  const body = await readJson(req).catch(() => ({}));
  return Response.json(await requestRender(clipService(userId), id, body), { status: 202 });
});
