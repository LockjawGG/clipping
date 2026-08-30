import { route } from "@/lib/api/http.ts";
import { workerService } from "@/lib/api/service.ts";
import { latestWorkerRun, startWorkerRun } from "@/lib/api/worker.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/videos/:id/worker — the latest run and its suggestions. */
export const GET = route<Ctx>(async (_req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await latestWorkerRun(workerService(userId), id));
});

/** POST /api/videos/:id/worker — queue a run. Suggestions are proposals only. */
export const POST = route<Ctx>(async (req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  return Response.json(await startWorkerRun(workerService(userId), id, body), { status: 202 });
});
