import { route } from "@/lib/api/http.ts";
import { liveService } from "@/lib/api/service.ts";
import { stopLive } from "@/lib/api/live.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/live/:id/stop — end the session, finalise into a normal video. */
export const POST = route<Ctx>(async (_req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await stopLive(liveService(userId), id));
});
