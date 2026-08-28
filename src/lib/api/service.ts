import { env } from "../env.ts";
import { db } from "../db.ts";
import { getStorage } from "../storage/index.ts";
import { enqueueJob } from "../jobs/prisma-store.ts";
import { getOrCreateProject } from "../auth/session.ts";
import { ApiError } from "./http.ts";
import { YtDlpFetcher, type MediaProbe } from "../pipeline/fetcher.ts";
import type { VideoServiceDeps } from "./videos.ts";
import type { ClipServiceDeps } from "./clips.ts";
import type { ProjectServiceDeps } from "./projects.ts";
import type { TranscriptServiceDeps } from "./transcript.ts";
import type { AssetServiceDeps } from "./assets.ts";
import type { OverlayServiceDeps } from "./overlays.ts";
import type { CaptionStyleServiceDeps } from "./caption-styles.ts";
import type { SequenceServiceDeps } from "./sequence.ts";

/** Throws 404 unless `projectId` belongs to `userId`. Shared by every service. */
function ownsProject(userId: string) {
  return async (projectId: string): Promise<void> => {
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { userId: true },
    });
    if (!project || project.userId !== userId) throw new ApiError(404, "not found");
  };
}

/** Video-service deps scoped to the signed-in user. */
export function videoService(userId: string): VideoServiceDeps {
  return {
    db: db as unknown as VideoServiceDeps["db"],
    storage: getStorage(),
    maxUploadBytes: env.MAX_UPLOAD_BYTES,
    defaultProjectId: () => getOrCreateProject(db, userId),
    assertProjectOwned: ownsProject(userId),
    enqueue: (input) => enqueueJob(db, input),
  };
}

/** Clip-service deps scoped to the signed-in user. */
export function clipService(userId: string): ClipServiceDeps {
  return {
    db: db as unknown as ClipServiceDeps["db"],
    storage: getStorage(),
    assertProjectOwned: ownsProject(userId),
    enqueue: (input) => enqueueJob(db, input),
  };
}

/** Project-service deps scoped to the signed-in user. */
export function projectService(userId: string): ProjectServiceDeps {
  return { db: db as unknown as ProjectServiceDeps["db"], userId };
}

/** Transcript-editing deps scoped to the signed-in user. */
export function transcriptService(userId: string): TranscriptServiceDeps {
  return {
    db: db as unknown as TranscriptServiceDeps["db"],
    assertProjectOwned: ownsProject(userId),
  };
}

/** Media-library deps scoped to the signed-in user. */
export function assetService(userId: string): AssetServiceDeps {
  return {
    db: db as unknown as AssetServiceDeps["db"],
    storage: getStorage(),
    maxUploadBytes: env.MAX_UPLOAD_BYTES,
    assertProjectOwned: ownsProject(userId),
  };
}

/** Clip-overlay deps scoped to the signed-in user. */
export function overlayService(userId: string): OverlayServiceDeps {
  return {
    db: db as unknown as OverlayServiceDeps["db"],
    storage: getStorage(),
    assertProjectOwned: ownsProject(userId),
  };
}

/** Per-word caption-styling deps scoped to the signed-in user. */
export function captionStyleService(userId: string): CaptionStyleServiceDeps {
  return {
    db: db as unknown as CaptionStyleServiceDeps["db"],
    assertProjectOwned: ownsProject(userId),
  };
}

/** Clip-timeline (sequence) deps scoped to the signed-in user. */
export function sequenceService(userId: string): SequenceServiceDeps {
  return {
    db: db as unknown as SequenceServiceDeps["db"],
    storage: getStorage(),
    assertProjectOwned: ownsProject(userId),
  };
}

/** yt-dlp-backed probe for URL analyze + downloader-version endpoints. */
export function mediaProbe(): MediaProbe {
  return new YtDlpFetcher({
    binPath: env.YTDLP_PATH,
    maxBytes: env.MAX_UPLOAD_BYTES,
    impersonate: env.YTDLP_IMPERSONATE,
  });
}
