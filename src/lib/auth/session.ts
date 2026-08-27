import type { PrismaClient } from "@prisma/client";

import { ApiError } from "../api/http.ts";
import { auth } from "./index.ts";

export async function currentUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}

/** For API routes: throw a 401 instead of returning null. */
export async function requireUserId(): Promise<string> {
  const id = await currentUserId();
  if (!id) throw new ApiError(401, "authentication required");
  return id;
}

/** The user's default project, created on first use. Replaces the dev stopgap. */
export async function getOrCreateProject(client: PrismaClient, userId: string): Promise<string> {
  const existing = await client.project.findFirst({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (existing) return existing.id;
  const project = await client.project.create({ data: { userId, name: "My Project" } });
  return project.id;
}
