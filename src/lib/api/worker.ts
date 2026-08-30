/**
 * Worker runs and their suggestions.
 *
 * The whole surface is proposal-shaped: a run produces suggestions, and the
 * only mutating operations are accept, reject and — for a highlight — turn it
 * into a real clip. Nothing the worker produces changes a project on its own.
 */

import { z } from "zod";

import type { JobKind } from "../jobs/types.ts";
import { ApiError } from "./http.ts";

export const runWorkerSchema = z
  .object({
    /** Narrow a run to one clip; omitted runs over the whole video. */
    clipId: z.string().min(1).nullable(),
    objectives: z
      .object({
        highlights: z.boolean(),
        reactions: z.boolean(),
        deadAir: z.boolean(),
      })
      .partial(),
    minClipMs: z.number().int().min(1000).max(600_000),
    maxClipMs: z.number().int().min(2000).max(1_800_000),
    maxClips: z.number().int().min(1).max(30),
  })
  .partial()
  .strict();

export const updateSuggestionSchema = z
  .object({
    status: z.enum(["PENDING", "ACCEPTED", "REJECTED", "APPLIED"]),
  })
  .strict();

/** Minimal Prisma surface, mirroring the other services in this directory. */
interface Db {
  video: {
    findUnique(args: {
      where: { id: string };
      select: Record<string, unknown>;
    }): Promise<{ id: string; projectId: string; durationMs: number | null } | null>;
  };
  workerRun: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    findUnique(args: {
      where: { id: string };
      select?: Record<string, unknown>;
      include?: Record<string, unknown>;
    }): Promise<WorkerRunRow | null>;
    findFirst(args: {
      where: Record<string, unknown>;
      orderBy?: unknown;
      include?: Record<string, unknown>;
    }): Promise<WorkerRunRow | null>;
  };
  workerSuggestion: {
    findUnique(args: {
      where: { id: string };
      include?: Record<string, unknown>;
    }): Promise<(SuggestionRow & { run: { videoId: string } }) | null>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<SuggestionRow>;
  };
}

export interface SuggestionRow {
  id: string;
  kind: string;
  startMs: number;
  endMs: number;
  score: number;
  reason: string;
  payloadJson: unknown;
  status: string;
  createdClipId: string | null;
}

export interface WorkerRunRow {
  id: string;
  videoId: string;
  clipId: string | null;
  status: string;
  errorMessage: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  suggestions: SuggestionRow[];
}

export interface WorkerServiceDeps {
  db: Db;
  /** Throws 404 unless the signed-in user owns the project. */
  assertProjectOwned: (projectId: string) => Promise<void>;
  enqueue: (input: { videoId: string; kind: JobKind; payload?: unknown }) => Promise<string>;
}

async function ownedVideo(deps: WorkerServiceDeps, videoId: string) {
  const video = await deps.db.video.findUnique({
    where: { id: videoId },
    select: { id: true, projectId: true, durationMs: true },
  });
  if (!video) throw new ApiError(404, "not found");
  await deps.assertProjectOwned(video.projectId);
  return video;
}

const SUGGESTION_INCLUDE = {
  suggestions: { orderBy: { startMs: "asc" as const } },
};

/** Queue a worker run over a video. Returns the run id to poll. */
export async function startWorkerRun(
  deps: WorkerServiceDeps,
  videoId: string,
  input: unknown,
): Promise<{ runId: string; status: string }> {
  const opts = runWorkerSchema.parse(input);
  await ownedVideo(deps, videoId);

  const run = await deps.db.workerRun.create({
    data: {
      videoId,
      clipId: opts.clipId ?? null,
      objectivesJson: opts.objectives ?? null,
      status: "QUEUED",
    },
  });

  await deps.enqueue({
    videoId,
    kind: "WORKER_RUN",
    payload: {
      runId: run.id,
      ...(opts.minClipMs ? { minClipMs: opts.minClipMs } : {}),
      ...(opts.maxClipMs ? { maxClipMs: opts.maxClipMs } : {}),
      ...(opts.maxClips ? { maxClips: opts.maxClips } : {}),
    },
  });

  return { runId: run.id, status: "QUEUED" };
}

/** The most recent run for a video, with its suggestions. Null if never run. */
export async function latestWorkerRun(
  deps: WorkerServiceDeps,
  videoId: string,
): Promise<WorkerRunRow | null> {
  await ownedVideo(deps, videoId);
  return deps.db.workerRun.findFirst({
    where: { videoId },
    orderBy: { createdAt: "desc" },
    include: SUGGESTION_INCLUDE,
  });
}

export async function getWorkerRun(
  deps: WorkerServiceDeps,
  runId: string,
): Promise<WorkerRunRow> {
  const run = await deps.db.workerRun.findUnique({
    where: { id: runId },
    include: SUGGESTION_INCLUDE,
  });
  if (!run) throw new ApiError(404, "not found");
  await ownedVideo(deps, run.videoId);
  return run;
}

/**
 * Accept or reject one suggestion.
 *
 * This is the only place a suggestion's status changes, and it is deliberately
 * a separate call from applying it: the decision is the signal worth recording,
 * whether or not the user then acts on it.
 */
export async function updateSuggestion(
  deps: WorkerServiceDeps,
  suggestionId: string,
  input: unknown,
): Promise<SuggestionRow> {
  const { status } = updateSuggestionSchema.parse(input);
  const existing = await deps.db.workerSuggestion.findUnique({
    where: { id: suggestionId },
    include: { run: { select: { videoId: true } } },
  });
  if (!existing) throw new ApiError(404, "not found");
  await ownedVideo(deps, existing.run.videoId);

  return deps.db.workerSuggestion.update({
    where: { id: suggestionId },
    data: { status },
  });
}
