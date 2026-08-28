import { readJson, route } from "@/lib/api/http.ts";
import { assetService } from "@/lib/api/service.ts";
import { deleteAsset, updateAsset } from "@/lib/api/assets.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** PATCH /api/assets/:id — rename / favorite. */
export const PATCH = route<Ctx>(async (req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await updateAsset(assetService(userId), id, await readJson(req)));
});

/** DELETE /api/assets/:id — remove the row and the stored file. */
export const DELETE = route<Ctx>(async (_req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await deleteAsset(assetService(userId), id));
});
