import { route } from "@/lib/api/http.ts";
import { learningService } from "@/lib/api/service.ts";
import { repositoryOverview } from "@/lib/api/learning.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

/** GET /api/training/repository — what has been learned, and from how much. */
export const GET = route(async () => {
  const userId = await requireUserId();
  return Response.json(await repositoryOverview(learningService(userId)));
});
