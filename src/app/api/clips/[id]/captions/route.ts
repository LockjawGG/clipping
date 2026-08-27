import { readJson, route } from "@/lib/api/http.ts";
import { clipService } from "@/lib/api/service.ts";
import { deleteCaptionConfig, upsertCaptionConfig } from "@/lib/api/clips.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** PUT /api/clips/:id/captions — create or update the clip's caption style. */
export const PUT = route<Ctx>(async (req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await upsertCaptionConfig(clipService(userId), id, await readJson(req)));
});

/** DELETE /api/clips/:id/captions — render this clip with no captions. */
export const DELETE = route<Ctx>(async (_req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await deleteCaptionConfig(clipService(userId), id));
});
