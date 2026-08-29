import { readJson, route } from "@/lib/api/http.ts";
import { overlayService } from "@/lib/api/service.ts";
import { createTextOverlay } from "@/lib/api/overlays.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/clips/:id/text-overlays — add a freestanding text element. */
export const POST = route<Ctx>(async (req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(
    await createTextOverlay(overlayService(userId), id, await readJson(req)),
    { status: 201 },
  );
});
