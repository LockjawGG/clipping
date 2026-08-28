import { z } from "zod";

import { readJson, route } from "@/lib/api/http.ts";
import { overlayService } from "@/lib/api/service.ts";
import { reorderOverlay } from "@/lib/api/overlays.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({ direction: z.enum(["up", "down"]) });

/** POST /api/overlays/:id/reorder — bring the overlay one step forward / back. */
export const POST = route<Ctx>(async (req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  const { direction } = bodySchema.parse(await readJson(req));
  return Response.json(await reorderOverlay(overlayService(userId), id, direction));
});
