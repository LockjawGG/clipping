import { readJson, route } from "@/lib/api/http.ts";
import { overlayService } from "@/lib/api/service.ts";
import { deleteOverlay, updateOverlay } from "@/lib/api/overlays.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** PATCH /api/overlays/:id — move / resize / re-time an overlay. */
export const PATCH = route<Ctx>(async (req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await updateOverlay(overlayService(userId), id, await readJson(req)));
});

/** DELETE /api/overlays/:id — take the overlay off the clip. */
export const DELETE = route<Ctx>(async (_req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await deleteOverlay(overlayService(userId), id));
});
