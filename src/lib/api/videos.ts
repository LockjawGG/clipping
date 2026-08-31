import { randomUUID } from "node:crypto";
import { extname } from "node:path";

import { z } from "zod";

import type { StorageProvider } from "../providers/types.ts";
import type { JobKind } from "../jobs/types.ts";
import { normalizeSourceUrl, sourceUrlHash } from "../ingest/url-cache.ts";
import { ApiError } from "./http.ts";
import { isLikelyPlaylistUrl, type MediaProbe } from "../pipeline/fetcher.ts";
import { TRANSLATE_TARGETS } from "../translation/targets.ts";

/**
 * The upload flow, as plain functions over injected deps so it can be tested
 * without HTTP or a database. The route handlers are thin shells over these.
 *
 *   POST /api/videos            -> createVideoUpload   (row + presigned PUT URL)
 *   client PUTs bytes to uploadUrl
 *   POST /api/videos/:id/ingest -> confirmUpload       (verify + enqueue PROBE)
 *   GET  /api/videos/:id        -> getVideoStatus
 */

export const createUploadSchema = z.object({
  filename: z.string().min(1).max(500),
  contentType: z
    .string()
    .regex(/^[-\w.]+\/[-\w.+]+$/, "not a MIME type")
    .refine((v) => v.startsWith("video/"), "must be a video/* content type"),
  sizeBytes: z.number().int().positive(),
  projectId: z.string().min(1).optional(),
});
export type CreateUploadInput = z.infer<typeof createUploadSchema>;

export const createFromUrlSchema = z.object({
  url: z
    .string()
    .url()
    .refine((v) => /^https?:\/\//i.test(v), "must be an http(s) URL")
    .refine((v) => v.length <= 2000, "URL is too long"),
  projectId: z.string().min(1).optional(),
});

export const updateVideoSchema = z
  .object({
    projectId: z.string().min(1),
    name: z.string().trim().min(1).max(300),
  })
  .partial()
  .refine((v) => v.projectId !== undefined || v.name !== undefined, "nothing to update");

/** Minimal slice of the Prisma client the upload flow needs. */
export interface VideoDb {
  video: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    findUnique(args: { where: { id: string } }): Promise<VideoRecord | null>;
    findFirst(args: {
      where: {
        sourceUrlHash: string;
        status: string;
        project: { userId: string };
      };
      orderBy?: unknown;
      select?: unknown;
    }): Promise<{ id: string; projectId: string } | null>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
    delete(args: { where: { id: string } }): Promise<unknown>;
  };
  clip: { count(args: { where: { videoId: string } }): Promise<number> };
  transcript: {
    findFirst(args: {
      where: { videoId: string; translatedTo?: string };
      orderBy?: unknown;
    }): Promise<{ language: string } | null>;
    findMany(args: {
      where: { videoId: string };
      select?: unknown;
      orderBy?: unknown;
    }): Promise<Array<{ translatedTo: string; language: string }>>;
  };
  job: {
    findMany(args: {
      where: Record<string, unknown>;
      orderBy?: unknown;
      select?: unknown;
    }): Promise<Array<{ kind: string }>>;
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
}

export interface VideoRecord {
  id: string;
  projectId: string;
  status: string;
  storageKey: string;
  originalFilename: string;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  errorMessage: string | null;
}

export interface VideoServiceDeps {
  db: VideoDb;
  storage: StorageProvider;
  maxUploadBytes: number;
  /** The signed-in user — scopes the "already transcribed this URL" lookup. */
  userId: string;
  /** The user's default project — new videos land here when none is given. */
  defaultProjectId: () => Promise<string>;
  /** Throws 404 unless the project is owned by the signed-in user. */
  assertProjectOwned: (projectId: string) => Promise<void>;
  enqueue: (input: { videoId: string; kind: JobKind; payload?: unknown }) => Promise<string>;
}

/** Resolve the target project: validate an explicit one, else the default. */
async function resolveProjectId(deps: VideoServiceDeps, projectId?: string): Promise<string> {
  if (projectId) {
    await deps.assertProjectOwned(projectId);
    return projectId;
  }
  return deps.defaultProjectId();
}

const SAFE_EXT = /^\.[a-z0-9]{1,8}$/;

function sourceKey(filename: string): string {
  const ext = extname(filename).toLowerCase();
  return `videos/${randomUUID()}/source${SAFE_EXT.test(ext) ? ext : ".mp4"}`;
}

export async function createVideoUpload(deps: VideoServiceDeps, input: unknown) {
  const parsed = createUploadSchema.parse(input);
  if (parsed.sizeBytes > deps.maxUploadBytes) {
    throw new ApiError(413, `file is larger than the ${deps.maxUploadBytes}-byte limit`);
  }

  const projectId = await resolveProjectId(deps, parsed.projectId);
  const storageKey = sourceKey(parsed.filename);
  const uploadUrl = await deps.storage.createUploadUrl(storageKey, parsed.contentType);

  const video = await deps.db.video.create({
    data: {
      projectId,
      status: "UPLOADING",
      originalFilename: parsed.filename.slice(0, 500),
      storageKey,
    },
  });

  return {
    videoId: video.id,
    storageKey,
    upload: { url: uploadUrl, method: "PUT" as const, headers: { "content-type": parsed.contentType } },
  };
}

/**
 * Ingest from a URL: create the row, enqueue FETCH (yt-dlp downloads
 * server-side). If the same normalised URL has already been transcribed for this
 * user, reuse that video instead of downloading and transcribing it again.
 */
export async function createVideoFromUrl(deps: VideoServiceDeps, input: unknown) {
  const { url, projectId: wanted } = createFromUrlSchema.parse(input);

  const normalized = normalizeSourceUrl(url);
  const hash = sourceUrlHash(normalized);

  const cached = await deps.db.video.findFirst({
    where: { sourceUrlHash: hash, status: "READY", project: { userId: deps.userId } },
    orderBy: { createdAt: "desc" },
    select: { id: true, projectId: true },
  });
  if (cached) {
    return { videoId: cached.id, projectId: cached.projectId, status: "READY" as const, reused: true };
  }

  const projectId = await resolveProjectId(deps, wanted);
  const storageKey = `videos/${randomUUID()}/source.mp4`;

  const video = await deps.db.video.create({
    data: {
      projectId,
      status: "UPLOADING",
      originalFilename: url.slice(0, 500),
      storageKey,
      sourceUrl: normalized,
      sourceUrlHash: hash,
    },
  });

  const jobId = await deps.enqueue({ videoId: video.id, kind: "FETCH", payload: { url } });
  return { videoId: video.id, jobId, status: "FETCHING" as const, reused: false };
}

/**
 * Ingest a link that may be a playlist: one video per entry, each through the
 * exact single-video path — so per-entry dedupe, project resolution and job
 * shape stay one implementation.
 *
 * Entries are ingested up to PLAYLIST_MAX; what got skipped is reported, not
 * swallowed. A failure on one entry stops the loop and reports how far it got
 * rather than failing the whole batch retroactively: the created videos are
 * real and already downloading, and pretending otherwise would orphan them.
 */
export async function createVideosFromUrl(
  deps: VideoServiceDeps,
  probe: Pick<MediaProbe, "probePlaylist">,
  input: unknown,
  playlistMax = 100,
) {
  const { url } = createFromUrlSchema.parse(input);
  if (!isLikelyPlaylistUrl(url)) return createVideoFromUrl(deps, input);

  const pl = await probe.probePlaylist(url);
  if (!pl || pl.entries.length <= 1) return createVideoFromUrl(deps, input);

  const take = pl.entries.slice(0, playlistMax);
  const videos: Array<{ videoId: string; reused: boolean; url: string }> = [];
  for (const entry of take) {
    const r = await createVideoFromUrl(deps, { url: entry.url, projectId: (input as { projectId?: string })?.projectId });
    videos.push({ videoId: r.videoId, reused: r.reused, url: entry.url });
  }
  return {
    playlist: true as const,
    title: pl.title,
    total: pl.total,
    added: videos.filter((v) => !v.reused).length,
    reused: videos.filter((v) => v.reused).length,
    skipped: Math.max(0, pl.entries.length - take.length),
    videos: videos.map((v) => v.videoId),
    status: "FETCHING" as const,
  };
}

/** 404 (not 403) for a video the caller doesn't own — don't leak ids. */
async function ownedVideo(deps: VideoServiceDeps, videoId: string): Promise<VideoRecord> {
  const video = await deps.db.video.findUnique({ where: { id: videoId } });
  if (!video) throw new ApiError(404, "video not found");
  await deps.assertProjectOwned(video.projectId);
  return video;
}

/** Rename a video and/or move it into another of the user's projects. */
export async function updateVideo(deps: VideoServiceDeps, videoId: string, input: unknown) {
  const { projectId, name } = updateVideoSchema.parse(input);
  await ownedVideo(deps, videoId);

  const data: Record<string, unknown> = {};
  if (name !== undefined) data.originalFilename = name;
  if (projectId !== undefined) {
    await deps.assertProjectOwned(projectId);
    data.projectId = projectId;
  }

  await deps.db.video.update({ where: { id: videoId }, data });
  return { id: videoId, ...(name !== undefined ? { name } : {}), ...(projectId ? { projectId } : {}) };
}


export { TRANSLATE_TARGETS } from "../translation/targets.ts";

const translateSchema = z.object({
  target: z.enum(TRANSLATE_TARGETS),
});

/**
 * Produce a translation of a video's transcript, stored alongside the original
 * (never replacing it). Re-extracts audio from the stored source and runs
 * Whisper in translate mode. The video stays READY and its clips untouched
 * while this builds. Idempotent-ish: a second call just regenerates it.
 */
export async function translateVideo(deps: VideoServiceDeps, videoId: string, input: unknown) {
  const { target } = translateSchema.parse(input);
  const video = await ownedVideo(deps, videoId);

  if (["PROBING", "TRANSCRIBING", "UPLOADING", "LIVE"].includes(video.status)) {
    throw new ApiError(409, "this video is still processing — try again once it's ready");
  }

  // "en": Whisper re-listens to the audio and translates as it goes.
  if (target === "en") {
    if (!(await deps.storage.exists(video.storageKey))) {
      throw new ApiError(409, "the source file for this video is missing");
    }
    const jobId = await deps.enqueue({
      videoId,
      kind: "EXTRACT_AUDIO",
      payload: { task: "translate", translatedTo: "en" },
    });
    return { videoId, target, via: "whisper" as const, jobId };
  }

  // Any other target: translate the existing transcript text offline.
  const primary = await deps.db.transcript.findFirst({ where: { videoId, translatedTo: "" } });
  if (!primary) {
    throw new ApiError(409, "transcribe this video before translating it");
  }
  const jobId = await deps.enqueue({
    videoId,
    kind: "TRANSLATE",
    payload: { to: target, from: primary.language },
  });
  return { videoId, target, via: "argos" as const, jobId };
}

/**
 * Re-run transcription on a video that is already done — used after the
 * project's transcription terms change, or to pick up a better model. Chains
 * EXTRACT_AUDIO -> TRANSCRIBE -> ANALYZE, which replaces the source transcript
 * (translations are left as they are). Refuses while an ingest is mid-flight.
 */
export async function retranscribeVideo(deps: VideoServiceDeps, videoId: string) {
  const video = await ownedVideo(deps, videoId);
  if (["PROBING", "TRANSCRIBING", "UPLOADING", "LIVE"].includes(video.status)) {
    throw new ApiError(409, "this video is still processing");
  }
  if (!(await deps.storage.exists(video.storageKey))) {
    throw new ApiError(409, "the source file for this video is missing");
  }
  await deps.db.video.update({
    where: { id: videoId },
    data: { status: "PROBING", errorMessage: null },
  });
  const jobId = await deps.enqueue({ videoId, kind: "EXTRACT_AUDIO" });
  return { videoId, status: "PROBING" as const, jobId };
}

export async function confirmUpload(deps: VideoServiceDeps, videoId: string) {
  const video = await ownedVideo(deps, videoId);

  if (video.status !== "UPLOADING") {
    // Idempotent: a second ingest call after PROBE was already queued is fine.
    return { videoId, status: video.status, alreadyStarted: true };
  }

  if (!(await deps.storage.exists(video.storageKey))) {
    throw new ApiError(409, "no uploaded file found; PUT the bytes to the upload URL first");
  }

  await deps.db.video.update({ where: { id: videoId }, data: { status: "UPLOADED" } });
  const jobId = await deps.enqueue({ videoId, kind: "PROBE" });

  return { videoId, status: "UPLOADED" as const, jobId };
}

/** Kick a stuck / failed ingest: reset its non-completed jobs to run now. */
export async function retryVideo(deps: VideoServiceDeps, videoId: string) {
  const video = await ownedVideo(deps, videoId);

  const stuck = await deps.db.job.findMany({
    where: { videoId, status: { in: ["FAILED", "PROCESSING", "QUEUED"] } },
    orderBy: { createdAt: "asc" },
    select: { kind: true },
  });
  if (stuck.length === 0) {
    return { videoId, requeued: 0, note: "nothing to retry" };
  }

  const res = await deps.db.job.updateMany({
    where: { videoId, status: { in: ["FAILED", "PROCESSING", "QUEUED"] } },
    data: { status: "QUEUED", attempts: 0, progress: 0, errorMessage: null, runAfter: new Date() },
  });

  // Pull the video out of a terminal state so the rail shows it as in-flight;
  // the handler for the requeued step will set the precise status.
  if (video.status === "FAILED") {
    await deps.db.video.update({ where: { id: videoId }, data: { status: "PROBING" } });
  }

  return { videoId, requeued: res.count };
}

/**
 * Cancel a stuck / failing ingest and remove it entirely: live jobs go
 * CANCELLED first (the worker polls this and aborts the in-flight download /
 * transcription), then the video row is deleted — Prisma cascades to its jobs,
 * transcript and clips — and its source file is cleaned up. Refuses a READY
 * video (nothing to cancel; deleting finished work needs its own action).
 */
export async function cancelVideo(deps: VideoServiceDeps, videoId: string) {
  const video = await ownedVideo(deps, videoId);
  if (video.status === "READY") {
    throw new ApiError(409, "video has finished processing — cancel only applies to in-progress or failed ingests");
  }

  const res = await deps.db.job.updateMany({
    where: { videoId, status: { in: ["QUEUED", "PROCESSING"] } },
    data: { status: "CANCELLED", errorMessage: "cancelled by user" },
  });
  await deps.db.video.delete({ where: { id: videoId } });
  await deps.storage.delete(video.storageKey).catch(() => {});

  return { videoId, cancelled: res.count, removed: true };
}

/**
 * Delete a video and everything under it, at any status. Any in-flight jobs are
 * CANCELLED first (the worker aborts them), then the row is deleted — Prisma
 * cascades to jobs, transcript and clips — and the source file is removed.
 * Unlike `cancelVideo`, this accepts a READY video (the "Delete" action in the
 * content rail).
 */
export async function deleteVideo(deps: VideoServiceDeps, videoId: string) {
  const video = await ownedVideo(deps, videoId);

  await deps.db.job.updateMany({
    where: { videoId, status: { in: ["QUEUED", "PROCESSING"] } },
    data: { status: "CANCELLED", errorMessage: "deleted by user" },
  });
  await deps.db.video.delete({ where: { id: videoId } });
  await deps.storage.delete(video.storageKey).catch(() => {});

  return { videoId, removed: true };
}

export async function getVideoStatus(deps: VideoServiceDeps, videoId: string) {
  const video = await ownedVideo(deps, videoId);

  const [clipCount, transcripts] = await Promise.all([
    deps.db.clip.count({ where: { videoId } }),
    deps.db.transcript.findMany({
      where: { videoId },
      select: { translatedTo: true, language: true },
    }),
  ]);
  const primary = transcripts.find((t) => t.translatedTo === "");

  return {
    id: video.id,
    status: video.status,
    originalFilename: video.originalFilename,
    durationMs: video.durationMs,
    width: video.width,
    height: video.height,
    clipCount,
    transcriptLanguage: primary?.language ?? null,
    translations: transcripts.filter((t) => t.translatedTo !== "").map((t) => t.translatedTo),
    errorMessage: video.errorMessage,
  };
}
