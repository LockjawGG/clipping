import { readJson, route } from "@/lib/api/http.ts";
import { projectService } from "@/lib/api/service.ts";
import { deleteProject, updateProject } from "@/lib/api/projects.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** PATCH /api/projects/:id — rename. */
export const PATCH = route<Ctx>(async (req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await updateProject(projectService(userId), id, await readJson(req)));
});

/** DELETE /api/projects/:id — refuses to remove the user's last project. */
export const DELETE = route<Ctx>(async (_req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await deleteProject(projectService(userId), id));
});
