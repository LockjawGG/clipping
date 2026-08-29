import { route } from "@/lib/api/http.ts";
import { liveService } from "@/lib/api/service.ts";
import { liveTranscriptSince } from "@/lib/api/live.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/live/:id/transcript?after=<segIndex> — rolling transcript tail. */
export const GET = route<Ctx>(async (req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  const after = Number(new URL(req.url).searchParams.get("after") ?? "-1");
  return Response.json(
    await liveTranscriptSince(liveService(userId), id, Number.isFinite(after) ? after : -1),
  );
});
