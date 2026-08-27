import type { PrismaClient } from "@prisma/client";

import { env } from "../env.ts";
import { db } from "../db.ts";
import { getStorage } from "../storage/index.ts";
import { enqueueJob } from "../jobs/prisma-store.ts";
import type { VideoServiceDeps } from "./videos.ts";

/**
 * Stopgap ownership: every video hangs off one dev user + project until auth
 * lands (PR: auth). Replace `ensureProject` with the session's project then.
 */
async function ensureDefaultProject(client: PrismaClient): Promise<string> {
  const user = await client.user.upsert({
    where: { email: "dev@localhost" },
    update: {},
    create: { email: "dev@localhost", name: "Dev" },
  });
  const existing = await client.project.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (existing) return existing.id;
  const project = await client.project.create({ data: { userId: user.id, name: "Default" } });
  return project.id;
}

/** The live video-service deps used by the route handlers. */
export function videoService(): VideoServiceDeps {
  return {
    db: db as unknown as VideoServiceDeps["db"],
    storage: getStorage(),
    maxUploadBytes: env.MAX_UPLOAD_BYTES,
    ensureProject: () => ensureDefaultProject(db),
    enqueue: (input) => enqueueJob(db, input),
  };
}
