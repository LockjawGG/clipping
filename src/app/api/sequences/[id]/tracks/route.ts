import { route } from "@/lib/api/http.ts";
import { sequenceService } from "@/lib/api/service.ts";
import { createSequenceTrack } from "@/lib/api/sequence.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/sequences/:id/tracks — add an empty layer to the timeline. */
export const POST = route<Ctx>(async (_req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await createSequenceTrack(sequenceService(userId), id), { status: 201 });
});
