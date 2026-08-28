import { readJson, route } from "@/lib/api/http.ts";
import { sequenceService } from "@/lib/api/service.ts";
import { deleteSequenceItem, updateSequenceItem } from "@/lib/api/sequence.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** PATCH /api/sequence-items/:id — move / trim / re-track / rename an item. */
export const PATCH = route<Ctx>(async (req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await updateSequenceItem(sequenceService(userId), id, await readJson(req)));
});

/** DELETE /api/sequence-items/:id — remove an item from the timeline. */
export const DELETE = route<Ctx>(async (_req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await deleteSequenceItem(sequenceService(userId), id));
});
