import { readJson, route } from "@/lib/api/http.ts";
import { clipService } from "@/lib/api/service.ts";
import { deleteClip, updateClip } from "@/lib/api/clips.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** PATCH /api/clips/:id — edit boundaries, aspect, focal point, accept flag. */
export const PATCH = route<Ctx>(async (req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await updateClip(clipService(userId), id, await readJson(req)));
});

/** DELETE /api/clips/:id */
export const DELETE = route<Ctx>(async (_req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await deleteClip(clipService(userId), id));
});
