import { readJson, route } from "@/lib/api/http.ts";
import { assetService } from "@/lib/api/service.ts";
import { confirmAsset } from "@/lib/api/assets.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/assets/:id/confirm — verify the bytes landed, attach dimensions. */
export const POST = route<Ctx>(async (req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await confirmAsset(assetService(userId), id, await readJson(req).catch(() => ({}))));
});
