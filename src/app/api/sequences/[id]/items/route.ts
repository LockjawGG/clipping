import { readJson, route } from "@/lib/api/http.ts";
import { sequenceService } from "@/lib/api/service.ts";
import { createSequenceItem } from "@/lib/api/sequence.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/sequences/:id/items — drop a project video / asset onto a track. */
export const POST = route<Ctx>(async (req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(
    await createSequenceItem(sequenceService(userId), id, await readJson(req)),
    { status: 201 },
  );
});
