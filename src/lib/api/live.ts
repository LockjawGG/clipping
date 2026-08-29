import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { StorageProvider } from "../providers/types.ts";
import type { JobKind } from "../jobs/types.ts";
import { ApiError } from "./http.ts";

/**
 * Live capture: the browser records mic (and optionally screen) audio as one
 * continuous MediaRecorder stream, flushing a fragment to storage every few
 * seconds purely for crash-durability. Nothing is transcribed while recording.
 * On Stop the fragments are reassembled into the video's source and the whole
 * thing is transcribed once at full quality (LIVE_FINALIZE) — far more accurate
 * and cheaper than decoding dozens of tiny isolated chunks — after which it's
 * an ordinary clippable video.
 */

export const startLiveSchema = z.object({
  projectId: z.string().min(1).optional(),
  title: z.string().trim().min(1).max(300).optional(),
});

export const addChunkSchema = z.object({
  index: z.number().int().min(0),
  startMs: z.number().int().min(0),
  durationMs: z.number().int().min(1).max(600_000).optional(),
  contentType: z.string().max(120).optional(),
  /** Size the browser is about to PUT, so a truncated upload is detectable. */
  bytes: z.number().int().min(0).optional(),
});

/**
 * A LIVE session whose browser stopped checking in for this long is treated as
 * abandoned: the sweeper finalises it from the fragments that did land. Well
 * clear of the client's 15s heartbeat, so a slow network can't orphan a
 * recording that is still going.
 */
export const LIVE_HEARTBEAT_TIMEOUT_MS = 120_000;

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

interface RecoverableRow {
  id: string;
  originalFilename: string;
  createdAt: Date;
  liveHeartbeatAt: Date | null;
  _count: { liveChunks: number };
}

export interface LiveDb {
  video: {
    create(a: { data: Record<string, unknown> }): Promise<{ id: string }>;
    findUnique(a: { where: { id: string }; select?: unknown }): Promise<VideoRow | null>;
    findMany(a: {
      where: Record<string, unknown>;
      orderBy?: unknown;
      select?: unknown;
    }): Promise<RecoverableRow[]>;
    update(a: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
    updateMany(a: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
  liveChunk: {
    upsert(a: {
      where: Record<string, unknown>;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<ChunkRow>;
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
  enqueue: (input: {
    videoId: string;
    kind: JobKind;
    payload?: unknown;
    runAfter?: Date;
    maxAttempts?: number;
  }) => Promise<string>;
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
    data: {
      projectId: resolved,
      status: "LIVE",
      originalFilename: name,
      storageKey,
      hasAudio: true,
      liveHeartbeatAt: new Date(),
    },
  });
  return { videoId: video.id, projectId: resolved };
}

/**
 * Client check-in. Keeps the session out of the sweeper's reach; a lapse is the
 * only signal that a recording tab died, since Stop can never arrive from a
 * browser that is gone. No-ops on a session that already left LIVE.
 */
export async function heartbeatLive(deps: LiveServiceDeps, videoId: string) {
  await ownedLiveVideo(deps, videoId);
  const { count } = await deps.db.video.updateMany({
    where: { id: videoId, status: "LIVE" },
    data: { liveHeartbeatAt: new Date() },
  });
  return { videoId, live: count > 0 };
}

/**
 * Sessions still marked LIVE that hold at least one fragment — a recording
 * whose tab closed without stopping. Offered back to the user as "recover
 * this", and picked up automatically by the sweeper once the heartbeat lapses.
 */
export async function listRecoverableLive(deps: LiveServiceDeps) {
  const rows = await deps.db.video.findMany({
    where: { status: "LIVE", project: { userId: deps.userId } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      originalFilename: true,
      createdAt: true,
      liveHeartbeatAt: true,
      _count: { select: { liveChunks: true } },
    },
  });
  return {
    sessions: rows
      .filter((r) => r._count.liveChunks > 0)
      .map((r) => ({
        videoId: r.id,
        name: r.originalFilename,
        startedAt: r.createdAt.toISOString(),
        fragments: r._count.liveChunks,
        /** False while a live tab is still checking in — don't offer that one. */
        stale:
          !r.liveHeartbeatAt ||
          Date.now() - r.liveHeartbeatAt.getTime() > LIVE_HEARTBEAT_TIMEOUT_MS,
      })),
  };
}

/**
 * Register the next recording fragment and hand back a presigned PUT. These
 * fragments are MediaRecorder timeslice output — only the first is
 * self-contained; the rest are continuation segments — so they're never
 * transcribed individually, just stored in order and reassembled on Stop.
 */
export async function addLiveChunk(deps: LiveServiceDeps, videoId: string, input: unknown) {
  const { index, startMs, durationMs, contentType, bytes } = addChunkSchema.parse(input);
  const video = await ownedLiveVideo(deps, videoId);
  if (video.status !== "LIVE") throw new ApiError(409, "this recording is no longer live");

  const mime =
    contentType && /^(audio|video)\/[-\w.+]+$/.test(contentType) ? contentType : "video/webm";
  const storageKey = `videos/${videoId}/chunks/${String(index).padStart(5, "0")}.webm`;
  // Idempotent: the outbox re-registers a fragment whose upload failed, and the
  // (videoId, index) unique would otherwise reject the retry.
  const chunk = await deps.db.liveChunk.upsert({
    where: { videoId_index: { videoId, index } },
    create: { videoId, index, startMs, durationMs: durationMs ?? null, bytes: bytes ?? null, storageKey },
    update: { bytes: bytes ?? null, durationMs: durationMs ?? null },
  });
  const uploadUrl = await deps.storage.createUploadUrl(storageKey, mime);
  // A fragment arriving is itself proof the tab is alive.
  await deps.db.video.updateMany({
    where: { id: videoId, status: "LIVE" },
    data: { liveHeartbeatAt: new Date() },
  });

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
      data: {
        status: "FAILED",
        errorMessage: "Live recording ended with no audio.",
        liveHeartbeatAt: null,
      },
    });
    return { videoId, status: "FAILED" as const, chunks: 0 };
  }

  // Leaving LIVE takes it out of the sweeper's scope; clear the heartbeat so
  // the column never outlives the session it described.
  await deps.db.video.update({
    where: { id: videoId },
    data: { status: "PROBING", liveHeartbeatAt: null },
  });
  const jobId = await deps.enqueue({ videoId, kind: "LIVE_FINALIZE" });
  return { videoId, status: "PROBING" as const, jobId };
}
