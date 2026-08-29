import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { StorageProvider } from "../providers/types.ts";
import type { JobKind } from "../jobs/types.ts";
import { ApiError } from "./http.ts";

/**
 * Live capture: the browser records mic (and optionally screen) audio, uploads
 * it in ~8s WebM chunks while the session runs, and each chunk is transcribed
 * on its own. On Stop the chunks are concatenated into the video's source and
 * the whole thing is re-transcribed at full quality (LIVE_FINALIZE), after
 * which it's an ordinary clippable video.
 */

export const startLiveSchema = z.object({
  projectId: z.string().min(1).optional(),
  title: z.string().trim().min(1).max(300).optional(),
});

export const addChunkSchema = z.object({
  index: z.number().int().min(0),
  startMs: z.number().int().min(0),
  durationMs: z.number().int().min(1).max(120_000).optional(),
  /** ms of audio the client believes it has recorded so far (for the UI). */
  contentType: z.string().max(120).optional(),
});

interface VideoRow {
  id: string;
  status: string;
  storageKey: string;
  project: { userId: string };
}
interface ChunkRow {
  id: string;
  videoId: string;
  index: number;
  startMs: number;
  status: string;
}
interface SegRow {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
  speaker: string | null;
  words: { id: string; text: string; startMs: number; endMs: number }[];
}

export interface LiveDb {
  video: {
    create(a: { data: Record<string, unknown> }): Promise<{ id: string }>;
    findUnique(a: { where: { id: string }; select?: unknown }): Promise<VideoRow | null>;
    update(a: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
  };
  liveChunk: {
    create(a: { data: Record<string, unknown> }): Promise<ChunkRow>;
    findFirst(a: { where: Record<string, unknown>; orderBy?: unknown }): Promise<ChunkRow | null>;
  };
  transcriptSegment: {
    findMany(a: {
      where: Record<string, unknown>;
      orderBy?: unknown;
      select?: unknown;
    }): Promise<SegRow[]>;
  };
}

export interface LiveServiceDeps {
  db: LiveDb;
  storage: StorageProvider;
  userId: string;
  defaultProjectId: () => Promise<string>;
  assertProjectOwned: (projectId: string) => Promise<void>;
  enqueue: (input: { videoId: string; kind: JobKind; payload?: unknown }) => Promise<string>;
}

async function ownedLiveVideo(deps: LiveServiceDeps, videoId: string): Promise<VideoRow> {
  const v = await deps.db.video.findUnique({
    where: { id: videoId },
    select: { id: true, status: true, storageKey: true, project: { select: { userId: true } } },
  });
  if (!v || v.project.userId !== deps.userId) throw new ApiError(404, "recording not found");
  return v;
}

/** Begin a session: a LIVE video the browser will feed chunks to. */
export async function startLive(deps: LiveServiceDeps, input: unknown) {
  const { projectId, title } = startLiveSchema.parse(input);
  const resolved = projectId
    ? (await deps.assertProjectOwned(projectId), projectId)
    : await deps.defaultProjectId();

  const storageKey = `videos/${randomUUID()}/source.webm`;
  const name = title ?? `Live recording ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  const video = await deps.db.video.create({
    data: { projectId: resolved, status: "LIVE", originalFilename: name, storageKey, hasAudio: true },
  });
  return { videoId: video.id, projectId: resolved };
}

/** Register the next chunk: a presigned PUT + a LIVE_TRANSCRIBE job. */
export async function addLiveChunk(deps: LiveServiceDeps, videoId: string, input: unknown) {
  const { index, startMs, durationMs, contentType } = addChunkSchema.parse(input);
  const video = await ownedLiveVideo(deps, videoId);
  if (video.status !== "LIVE") throw new ApiError(409, "this recording is no longer live");

  const mime =
    contentType && /^(audio|video)\/[-\w.+]+$/.test(contentType) ? contentType : "video/webm";
  const storageKey = `videos/${videoId}/chunks/${String(index).padStart(5, "0")}.webm`;
  const chunk = await deps.db.liveChunk.create({
    data: { videoId, index, startMs, durationMs: durationMs ?? null, storageKey },
  });
  const uploadUrl = await deps.storage.createUploadUrl(storageKey, mime);
  await deps.enqueue({ videoId, kind: "LIVE_TRANSCRIBE", payload: { chunkId: chunk.id } });

  return {
    chunkId: chunk.id,
    upload: { url: uploadUrl, method: "PUT" as const, headers: { "content-type": mime } },
  };
}

/** Rolling transcript: segments written since `afterIndex`. */
export async function liveTranscriptSince(deps: LiveServiceDeps, videoId: string, afterIndex: number) {
  await ownedLiveVideo(deps, videoId);
  const rows = await deps.db.transcriptSegment.findMany({
    where: { transcript: { videoId }, index: { gt: afterIndex } },
    orderBy: { index: "asc" },
    select: {
      index: true,
      startMs: true,
      endMs: true,
      text: true,
      speaker: true,
      words: {
        orderBy: { index: "asc" },
        select: { id: true, text: true, startMs: true, endMs: true },
      },
    },
  });
  const lastIndex = rows.length ? rows[rows.length - 1].index : afterIndex;
  return { segments: rows, lastIndex };
}

/** Stop the session and kick off finalisation. Idempotent. */
export async function stopLive(deps: LiveServiceDeps, videoId: string) {
  const video = await ownedLiveVideo(deps, videoId);
  if (video.status !== "LIVE") return { videoId, status: video.status, alreadyStopped: true };

  const anyChunk = await deps.db.liveChunk.findFirst({ where: { videoId } });
  if (!anyChunk) {
    await deps.db.video.update({
      where: { id: videoId },
      data: { status: "FAILED", errorMessage: "Live recording ended with no audio." },
    });
    return { videoId, status: "FAILED" as const, chunks: 0 };
  }

  await deps.db.video.update({ where: { id: videoId }, data: { status: "PROBING" } });
  const jobId = await deps.enqueue({ videoId, kind: "LIVE_FINALIZE" });
  return { videoId, status: "PROBING" as const, jobId };
}
