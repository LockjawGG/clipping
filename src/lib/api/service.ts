import { env } from "../env.ts";
import { db } from "../db.ts";
import { getStorage } from "../storage/index.ts";
import { enqueueJob } from "../jobs/prisma-store.ts";
import { getOrCreateProject } from "../auth/session.ts";
import type { VideoServiceDeps } from "./videos.ts";
import type { ClipServiceDeps } from "./clips.ts";

/** Video-service deps scoped to the signed-in user. */
export function videoService(userId: string): VideoServiceDeps {
  return {
    db: db as unknown as VideoServiceDeps["db"],
    storage: getStorage(),
    maxUploadBytes: env.MAX_UPLOAD_BYTES,
    ensureProject: () => getOrCreateProject(db, userId),
    enqueue: (input) => enqueueJob(db, input),
  };
}

/** Clip-service deps scoped to the signed-in user. */
export function clipService(userId: string): ClipServiceDeps {
  return {
    db: db as unknown as ClipServiceDeps["db"],
    storage: getStorage(),
    ensureProject: () => getOrCreateProject(db, userId),
    enqueue: (input) => enqueueJob(db, input),
  };
}
