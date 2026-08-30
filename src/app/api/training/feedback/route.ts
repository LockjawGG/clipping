import { route } from "@/lib/api/http.ts";
import { learningService } from "@/lib/api/service.ts";
import { recordFeedback } from "@/lib/api/learning.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

/** POST /api/training/feedback — record an accept / reject / modify. */
export const POST = route(async (req) => {
  const userId = await requireUserId();
  const body = await req.json().catch(() => ({}));
  return Response.json(await recordFeedback(learningService(userId), body), { status: 201 });
});
