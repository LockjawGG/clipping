import { randomUUID } from "node:crypto";
import { extname } from "node:path";

import { z } from "zod";

import type { StorageProvider } from "../providers/types.ts";
import type { JobKind } from "../jobs/types.ts";
import { ApiError } from "./http.ts";

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
});
export type CreateUploadInput = z.infer<typeof createUploadSchema>;

/** Minimal slice of the Prisma client the upload flow needs. */
export interface VideoDb {
  video: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    findUnique(args: { where: { id: string } }): Promise<VideoRecord | null>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
  };
  clip: { count(args: { where: { videoId: string } }): Promise<number> };
  transcript: {
    findUnique(args: {
      where: { videoId: string };
    }): Promise<{ language: string } | null>;
  };
}

export interface VideoRecord {
  id: string;
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
  /** Returns the project id new videos are attached to (auth replaces this). */
  ensureProject: () => Promise<string>;
  enqueue: (input: { videoId: string; kind: JobKind }) => Promise<string>;
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

  const projectId = await deps.ensureProject();
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

export async function confirmUpload(deps: VideoServiceDeps, videoId: string) {
  const video = await deps.db.video.findUnique({ where: { id: videoId } });
  if (!video) throw new ApiError(404, "video not found");

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

export async function getVideoStatus(deps: VideoServiceDeps, videoId: string) {
  const video = await deps.db.video.findUnique({ where: { id: videoId } });
  if (!video) throw new ApiError(404, "video not found");

  const [clipCount, transcript] = await Promise.all([
    deps.db.clip.count({ where: { videoId } }),
    deps.db.transcript.findUnique({ where: { videoId } }),
  ]);

  return {
    id: video.id,
    status: video.status,
    originalFilename: video.originalFilename,
    durationMs: video.durationMs,
    width: video.width,
    height: video.height,
    clipCount,
    transcriptLanguage: transcript?.language ?? null,
    errorMessage: video.errorMessage,
  };
}
