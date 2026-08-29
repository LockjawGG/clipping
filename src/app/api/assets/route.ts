import { readJson, route } from "@/lib/api/http.ts";
import { assetService } from "@/lib/api/service.ts";
import { createAssetUpload, listAssets } from "@/lib/api/assets.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/assets — the signed-in user's whole media library. */
export const GET = route(async () => {
  const userId = await requireUserId();
  return Response.json(await listAssets(assetService(userId)));
});

/** POST /api/assets — create a row + presigned upload URL. */
export const POST = route(async (req: Request) => {
  const userId = await requireUserId();
  return Response.json(await createAssetUpload(assetService(userId), await readJson(req)), {
    status: 201,
  });
});
