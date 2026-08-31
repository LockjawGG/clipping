import type { PrismaClient } from "@prisma/client";

import { ApiError } from "../api/http.ts";
import { auth } from "./index.ts";
import { env } from "../env.ts";

/**
 * The single local user, in desktop mode.
 *
 * Created on first use rather than seeded, so a fresh install has nothing to
 * migrate and the row is made by whichever request happens to arrive first.
 * Its email is a marker, not an address — nothing is ever sent to it.
 */
const LOCAL_USER_EMAIL = "local@clipper.desktop";

async function localUserId(): Promise<string> {
  // Imported here rather than at module scope: the edge middleware pulls this
  // file's siblings in, and Prisma must not follow.
  const { db } = await import("../db.ts");
  const existing = await db.user.findUnique({
    where: { email: LOCAL_USER_EMAIL },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await db.user.create({
    data: { email: LOCAL_USER_EMAIL, name: "You" },
    select: { id: true },
  });
  return created.id;
}

export async function currentUserId(): Promise<string | null> {
  // Desktop: one user, no sign-in. Ownership checks still run against a real
  // User row, so nothing downstream knows the difference.
  if (env.DESKTOP_SINGLE_USER) return localUserId();
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
