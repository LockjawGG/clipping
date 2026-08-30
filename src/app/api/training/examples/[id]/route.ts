import { route } from "@/lib/api/http.ts";
import { learningService } from "@/lib/api/service.ts";
import { removeTrainingExample } from "@/lib/api/learning.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** DELETE /api/training/examples/:id — drop one example from the repository. */
export const DELETE = route<Ctx>(async (_req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await removeTrainingExample(learningService(userId), id));
});
