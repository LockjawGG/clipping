import { route } from "@/lib/api/http.ts";
import { workerService } from "@/lib/api/service.ts";
import { updateSuggestion } from "@/lib/api/worker.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** PATCH /api/worker-suggestions/:id — accept or reject one suggestion. */
export const PATCH = route<Ctx>(async (req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  return Response.json(await updateSuggestion(workerService(userId), id, body));
});
