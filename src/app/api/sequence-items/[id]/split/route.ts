import { readJson, route } from "@/lib/api/http.ts";
import { sequenceService } from "@/lib/api/service.ts";
import { splitSequenceItem } from "@/lib/api/sequence.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/sequence-items/:id/split { atMs } — cut the item in two at atMs. */
export const POST = route<Ctx>(async (req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await splitSequenceItem(sequenceService(userId), id, await readJson(req)));
});
