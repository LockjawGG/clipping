import { route } from "@/lib/api/http.ts";
import { sequenceService } from "@/lib/api/service.ts";
import { getOrCreateClipSequence } from "@/lib/api/sequence.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/clips/:id/sequence — the clip's timeline, creating it on first open. */
export const GET = route<Ctx>(async (_req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await getOrCreateClipSequence(sequenceService(userId), id));
});
