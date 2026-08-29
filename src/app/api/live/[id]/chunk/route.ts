import { readJson, route } from "@/lib/api/http.ts";
import { liveService } from "@/lib/api/service.ts";
import { addLiveChunk } from "@/lib/api/live.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/live/:id/chunk — register the next audio chunk, get a presigned PUT. */
export const POST = route<Ctx>(async (req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await addLiveChunk(liveService(userId), id, await readJson(req)));
});
