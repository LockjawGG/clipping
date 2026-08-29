import { route } from "@/lib/api/http.ts";
import { liveService } from "@/lib/api/service.ts";
import { listRecoverableLive } from "@/lib/api/live.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/live/recoverable — sessions whose browser never came back. */
export const GET = route(async () => {
  const userId = await requireUserId();
  return Response.json(await listRecoverableLive(liveService(userId)));
});
