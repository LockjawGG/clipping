import { readJson, route } from "@/lib/api/http.ts";
import { liveService } from "@/lib/api/service.ts";
import { startLive } from "@/lib/api/live.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

/** POST /api/live — begin a live-capture session. */
export const POST = route(async (req: Request) => {
  const userId = await requireUserId();
  return Response.json(await startLive(liveService(userId), await readJson(req).catch(() => ({}))), {
    status: 201,
  });
});
