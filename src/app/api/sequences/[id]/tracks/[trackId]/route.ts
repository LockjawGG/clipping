import { route } from "@/lib/api/http.ts";
import { sequenceService } from "@/lib/api/service.ts";
import { deleteSequenceTrack } from "@/lib/api/sequence.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; trackId: string }> };

/** DELETE /api/sequences/:id/tracks/:trackId — remove an empty layer. */
export const DELETE = route<Ctx>(async (_req, { params }) => {
  const userId = await requireUserId();
  const { id, trackId } = await params;
  return Response.json(await deleteSequenceTrack(sequenceService(userId), id, trackId));
});
