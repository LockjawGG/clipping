import { readJson, route } from "@/lib/api/http.ts";
import { sequenceService } from "@/lib/api/service.ts";
import { updateSequence } from "@/lib/api/sequence.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** PATCH /api/sequences/:id — output width / height / fps / snap toggle. */
export const PATCH = route<Ctx>(async (req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await updateSequence(sequenceService(userId), id, await readJson(req)));
});
