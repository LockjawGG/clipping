import { route } from "@/lib/api/http.ts";
import { learningService } from "@/lib/api/service.ts";
import { approveForTraining } from "@/lib/api/learning.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/clips/:id/train — approve this edit as something to learn from. */
export const POST = route<Ctx>(async (req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  return Response.json(await approveForTraining(learningService(userId), id, body), { status: 201 });
});
