import { readJson, route } from "@/lib/api/http.ts";
import { assetService } from "@/lib/api/service.ts";
import { createAssetUpload, listAssets } from "@/lib/api/assets.ts";
import { requireUserId } from "@/lib/auth/session.ts";
import { ApiError } from "@/lib/api/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/assets?project=<id> — the project's media library. */
export const GET = route(async (req: Request) => {
  const userId = await requireUserId();
  const projectId = new URL(req.url).searchParams.get("project");
  if (!projectId) throw new ApiError(400, "missing ?project");
  return Response.json(await listAssets(assetService(userId), projectId));
});

/** POST /api/assets — create a row + presigned upload URL. */
export const POST = route(async (req: Request) => {
  const userId = await requireUserId();
  return Response.json(await createAssetUpload(assetService(userId), await readJson(req)), {
    status: 201,
  });
});
