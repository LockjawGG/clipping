import { route } from "@/lib/api/http.ts";
import { sequenceService } from "@/lib/api/service.ts";
import { listInsertableMedia } from "@/lib/api/sequence.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/clips/:id/media — videos that can be added to this clip's timeline. */
export const GET = route<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  const userId = await requireUserId();
  return Response.json({ media: await listInsertableMedia(sequenceService(userId), id) });
});
