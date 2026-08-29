import { route } from "@/lib/api/http.ts";
import { liveService } from "@/lib/api/service.ts";
import { heartbeatLive } from "@/lib/api/live.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/live/:id/heartbeat — "this tab is still recording". */
export const POST = route<Ctx>(async (_req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await heartbeatLive(liveService(userId), id));
});
