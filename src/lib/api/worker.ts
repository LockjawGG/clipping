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
  /**
   * Create a clip from an accepted highlight. Injected rather than done here so
   * there stays exactly one clip-creation path — sentence snapping and learned
   * defaults must apply to a worker highlight exactly as they do to a manual
   * clip.
   */
  createClip: (
    videoId: string,
    input: {
      startMs: number;
      endMs: number;
      title?: string;
      hook?: string | null;
      caption?: string | null;
      socialTitle?: string | null;
      hashtags?: string[];
      reason?: string | null;
      score?: number | null;
      origin?: "AI_SUGGESTED" | "USER_CREATED";
    },
  ) => Promise<{ id: string; appliedDefaults: string[] }>;
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

interface HighlightPayload {
  title?: unknown;
  hook?: unknown;
  caption?: unknown;
  socialTitle?: unknown;
  hashtags?: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/**
 * Accept or reject one suggestion.
 *
 * Accepting a HIGHLIGHT turns it into a real clip; the other kinds only record
 * the decision. That asymmetry is deliberate. "Cut this dead air" and "look at
 * this reaction" have no single obvious edit to perform — applying them
 * silently would be a different way of doing something the user did not ask
 * for — whereas a highlight *is* a clip, so creating it is the whole point.
 *
 * The decision is recorded either way, because the accept / reject signal is
 * worth learning from whether or not it produced an edit.
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

  // Creating the clip is idempotent: a second accept (or an undo followed by a
  // re-accept) links back to the clip that already exists rather than making a
  // duplicate the user then has to find and delete.
  if (status === "ACCEPTED" && existing.kind === "HIGHLIGHT" && !existing.createdClipId) {
    const payload = (existing.payloadJson ?? {}) as HighlightPayload;
    const created = await deps.createClip(existing.run.videoId, {
      startMs: existing.startMs,
      endMs: existing.endMs,
      title: str(payload.title) ?? "Suggested clip",
      hook: str(payload.hook) ?? null,
      caption: str(payload.caption) ?? null,
      socialTitle: str(payload.socialTitle) ?? null,
      hashtags: Array.isArray(payload.hashtags)
        ? payload.hashtags.filter((h): h is string => typeof h === "string")
        : [],
      reason: existing.reason,
      score: existing.score,
      origin: "AI_SUGGESTED",
    });
    return deps.db.workerSuggestion.update({
      where: { id: suggestionId },
      data: { status: "APPLIED", createdClipId: created.id },
    });
  }

  // An accepted highlight that already has its clip stays APPLIED — reverting
  // to ACCEPTED would misreport a clip that exists as one that does not.
  const next =
    status === "ACCEPTED" && existing.kind === "HIGHLIGHT" && existing.createdClipId
      ? "APPLIED"
      : status;

  // Undo never deletes the clip. The user may have edited it since, and
  // silently removing their work to honour an undo of a *decision* would be a
  // far worse surprise than leaving an extra clip behind.
  return deps.db.workerSuggestion.update({
    where: { id: suggestionId },
    data: { status: next },
  });
}
