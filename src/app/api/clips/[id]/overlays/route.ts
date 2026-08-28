import { readJson, route } from "@/lib/api/http.ts";
import { overlayService } from "@/lib/api/service.ts";
import { createOverlayFromAsset, listClipOverlays } from "@/lib/api/overlays.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/clips/:id/overlays — the clip's overlay stack, bottom to top. */
export const GET = route<Ctx>(async (_req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await listClipOverlays(overlayService(userId), id));
});

/** POST /api/clips/:id/overlays — drop a library asset onto the clip. */
export const POST = route<Ctx>(async (req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(
    await createOverlayFromAsset(overlayService(userId), id, await readJson(req)),
    { status: 201 },
  );
});
