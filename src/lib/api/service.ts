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
import type { TextPresetServiceDeps } from "./text-presets.ts";
import type { SequenceServiceDeps } from "./sequence.ts";
import type { LiveServiceDeps } from "./live.ts";
import type { WorkerServiceDeps } from "./worker.ts";
import type { LearningServiceDeps } from "./learning.ts";

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
    userId,
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

/** AI worker runs + suggestions, scoped to the signed-in user. */
export function workerService(userId: string): WorkerServiceDeps {
  return {
    db: db as unknown as WorkerServiceDeps["db"],
    assertProjectOwned: ownsProject(userId),
    enqueue: (input) => enqueueJob(db, input),
  };
}

/** Training repository + style profiles, scoped to the signed-in user. */
export function learningService(userId: string): LearningServiceDeps {
  return {
    db: db as unknown as LearningServiceDeps["db"],
    userId,
    assertProjectOwned: ownsProject(userId),
  };
}

/** Project-service deps scoped to the signed-in user. */
export function projectService(userId: string): ProjectServiceDeps {
  return { db: db as unknown as ProjectServiceDeps["db"], userId };
}

/** Saved Text & Captions style presets scoped to the signed-in user. */
export function textPresetService(userId: string): TextPresetServiceDeps {
  return { db: db as unknown as TextPresetServiceDeps["db"], userId };
}

/** Transcript-editing deps scoped to the signed-in user. */
export function transcriptService(userId: string): TranscriptServiceDeps {
  return {
    db: db as unknown as TranscriptServiceDeps["db"],
    assertProjectOwned: ownsProject(userId),
  };
}

/** Live-capture deps scoped to the signed-in user. */
export function liveService(userId: string): LiveServiceDeps {
  return {
    db: db as unknown as LiveServiceDeps["db"],
    storage: getStorage(),
    userId,
    defaultProjectId: () => getOrCreateProject(db, userId),
    assertProjectOwned: ownsProject(userId),
    enqueue: (input) => enqueueJob(db, input),
  };
}

/** Media-library deps scoped to the signed-in user (library is user-wide). */
export function assetService(userId: string): AssetServiceDeps {
  return {
    db: db as unknown as AssetServiceDeps["db"],
    storage: getStorage(),
    maxUploadBytes: env.MAX_UPLOAD_BYTES,
    userId,
  };
}

/** Clip-overlay deps scoped to the signed-in user. */
export function overlayService(userId: string): OverlayServiceDeps {
  return {
    db: db as unknown as OverlayServiceDeps["db"],
    storage: getStorage(),
    assertProjectOwned: ownsProject(userId),
    userId,
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
    userId,
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
