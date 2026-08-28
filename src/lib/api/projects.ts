import { z } from "zod";

import { ApiError } from "./http.ts";

/**
 * Project CRUD behind injectable deps. A user always has at least one project;
 * `deleteProject` refuses to remove the last one.
 */

const nameSchema = z.string().trim().min(1).max(80);
export const createProjectSchema = z.object({ name: nameSchema });
export const renameProjectSchema = z.object({ name: nameSchema });

interface ProjectRow {
  id: string;
  name: string;
  createdAt: Date;
  _count: { videos: number };
}

export interface ProjectDb {
  project: {
    findMany(args: {
      where: { userId: string };
      orderBy?: unknown;
      include?: unknown;
    }): Promise<ProjectRow[]>;
    findUnique(args: {
      where: { id: string };
    }): Promise<{ id: string; userId: string } | null>;
    create(args: { data: { userId: string; name: string } }): Promise<{
      id: string;
      name: string;
      createdAt: Date;
    }>;
    update(args: {
      where: { id: string };
      data: { name: string };
    }): Promise<{ id: string; name: string }>;
    delete(args: { where: { id: string } }): Promise<unknown>;
    count(args: { where: { userId: string } }): Promise<number>;
  };
}

export interface ProjectServiceDeps {
  db: ProjectDb;
  userId: string;
}

async function ownProject(deps: ProjectServiceDeps, projectId: string): Promise<void> {
  const project = await deps.db.project.findUnique({ where: { id: projectId } });
  if (!project || project.userId !== deps.userId) throw new ApiError(404, "not found");
}

export async function listProjects(deps: ProjectServiceDeps) {
  const rows = await deps.db.project.findMany({
    where: { userId: deps.userId },
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { videos: true } } },
  });
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    videoCount: p._count.videos,
  }));
}

export async function createProject(deps: ProjectServiceDeps, input: unknown) {
  const { name } = createProjectSchema.parse(input);
  const project = await deps.db.project.create({ data: { userId: deps.userId, name } });
  return { id: project.id, name: project.name, createdAt: project.createdAt, videoCount: 0 };
}

export async function renameProject(deps: ProjectServiceDeps, projectId: string, input: unknown) {
  const { name } = renameProjectSchema.parse(input);
  await ownProject(deps, projectId);
  const updated = await deps.db.project.update({ where: { id: projectId }, data: { name } });
  return { id: updated.id, name: updated.name };
}

export async function deleteProject(deps: ProjectServiceDeps, projectId: string) {
  await ownProject(deps, projectId);
  const total = await deps.db.project.count({ where: { userId: deps.userId } });
  if (total <= 1) throw new ApiError(400, "you must keep at least one project");
  await deps.db.project.delete({ where: { id: projectId } });
  return { id: projectId, deleted: true };
}
