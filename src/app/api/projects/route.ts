import { readJson, route } from "@/lib/api/http.ts";
import { projectService } from "@/lib/api/service.ts";
import { createProject, listProjects } from "@/lib/api/projects.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/projects — the signed-in user's projects. */
export const GET = route(async () => {
  const userId = await requireUserId();
  return Response.json(await listProjects(projectService(userId)));
});

/** POST /api/projects — create a project. */
export const POST = route(async (req: Request) => {
  const userId = await requireUserId();
  return Response.json(await createProject(projectService(userId), await readJson(req)), {
    status: 201,
  });
});
