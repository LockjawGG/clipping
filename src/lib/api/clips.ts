import { z } from "zod";

import type { Segment, StorageProvider } from "../providers/types.ts";
import { DEFAULT_SNAP_CONFIG, snapToSentences } from "../clips/boundaries.ts";
import { CAPTION_ANIMATIONS } from "../captions/presets.ts";
import { ApiError } from "./http.ts";

/**
 * Clip actions behind injectable deps (same shape as the video service):
 * request a render, list a video's clips, edit a clip, delete one, and add a
 * manual clip snapped to sentence boundaries.
 */

const ASPECTS = ["VERTICAL_9_16", "SQUARE_1_1", "LANDSCAPE_16_9", "PORTRAIT_4_5"] as const;

export const renderRequestSchema = z.object({
  quality: z.enum(["P720", "P1080", "ORIGINAL"]).default("P1080"),
  aspectRatio: z.enum(ASPECTS).optional(),
});

export const updateClipSchema = z
  .object({
    title: z.string().min(1).max(200),
    caption: z.string().max(500),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    aspectRatio: z.enum(ASPECTS),
    focalX: z.number().min(0).max(1).nullable(),
    focalY: z.number().min(0).max(1).nullable(),
    muted: z.boolean(),
    volume: z.number().min(0).max(2),
    playbackRate: z.number().min(0.25).max(4),
    accepted: z.boolean(),
  })
  .partial()
  .strict();

export const manualClipSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  title: z.string().min(1).max(200).optional(),
});

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected a #rrggbb hex colour");

export const captionConfigSchema = z
  .object({
    preset: z.enum(["CLASSIC", "BOLD", "VIRAL", "MINIMAL", "KARAOKE"]),
    animation: z.enum(CAPTION_ANIMATIONS as unknown as [string, ...string[]]),
    fontFamily: z.string().min(1).max(100),
    fontSizePx: z.number().int().min(12).max(200),
    fontWeight: z.number().int().min(100).max(900),
    textColor: hexColor,
    highlightColor: hexColor,
    outlineColor: hexColor,
    outlineWidthPx: z.number().int().min(0).max(30),
    positionY: z.number().min(0).max(1),
    uppercase: z.boolean(),
  })
  .partial()
  .strict();

interface ClipRow {
  id: string;
  videoId: string;
  startMs: number;
  endMs: number;
}

interface ClipListRow {
  id: string;
  origin: string;
  title: string;
  startMs: number;
  endMs: number;
  score: number | null;
  aspectRatio: string;
  focalX: number | null;
  focalY: number | null;
  accepted: boolean;
  caption: string | null;
  thumbnailKey: string | null;
  subtitleConfig: {
    preset: string;
    animation: string;
    textColor: string;
    highlightColor: string;
    positionY: number;
    uppercase: boolean;
  } | null;
  renders: Array<{ id: string; status: string; progress: number; outputKey: string | null }>;
}

export interface ClipDb {
  clip: {
    findUnique(args: { where: { id: string } }): Promise<ClipRow | null>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    delete(args: { where: { id: string } }): Promise<unknown>;
    findMany(args: {
      where: { videoId: string };
      orderBy?: unknown;
      include?: unknown;
    }): Promise<ClipListRow[]>;
  };
  video: {
    findUnique(args: {
      where: { id: string };
    }): Promise<{ projectId: string; durationMs: number | null } | null>;
  };
  transcriptSegment: {
    findMany(args: {
      where: { transcript: { videoId: string } };
    }): Promise<Array<{ startMs: number; endMs: number }>>;
  };
  render: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    findFirst(args: {
      where: { clipId: string; status: { in: string[] } };
    }): Promise<{ id: string; status: string } | null>;
  };
  subtitleConfig: {
    upsert(args: {
      where: { clipId: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<Record<string, unknown>>;
    deleteMany(args: { where: { clipId: string } }): Promise<{ count: number }>;
  };
}

export interface ClipServiceDeps {
  db: ClipDb;
  storage: StorageProvider;
  ensureProject: () => Promise<string>;
  enqueue: (input: {
    videoId: string;
    kind: "RENDER" | "THUMBNAIL";
    payload?: unknown;
  }) => Promise<string>;
}

async function assertOwnsProject(deps: ClipServiceDeps, projectId: string | undefined | null): Promise<void> {
  if (!projectId || projectId !== (await deps.ensureProject())) {
    throw new ApiError(404, "not found");
  }
}

async function ownedClip(deps: ClipServiceDeps, clipId: string): Promise<ClipRow> {
  const clip = await deps.db.clip.findUnique({ where: { id: clipId } });
  if (!clip) throw new ApiError(404, "clip not found");
  const video = await deps.db.video.findUnique({ where: { id: clip.videoId } });
  await assertOwnsProject(deps, video?.projectId);
  return clip;
}

export async function requestRender(deps: ClipServiceDeps, clipId: string, input: unknown) {
  const { quality, aspectRatio } = renderRequestSchema.parse(input);
  const clip = await ownedClip(deps, clipId);

  // One render at a time per clip — return the in-flight one rather than
  // stacking duplicates.
  const inFlight = await deps.db.render.findFirst({
    where: { clipId, status: { in: ["QUEUED", "PROCESSING"] } },
  });
  if (inFlight) {
    return { renderId: inFlight.id, jobId: null, status: inFlight.status, alreadyRunning: true };
  }

  if (aspectRatio) {
    await deps.db.clip.update({ where: { id: clipId }, data: { aspectRatio } });
  }

  const render = await deps.db.render.create({
    data: { clipId, quality, status: "QUEUED", progress: 0 },
  });
  const jobId = await deps.enqueue({
    videoId: clip.videoId,
    kind: "RENDER",
    payload: { renderId: render.id },
  });

  return { renderId: render.id, jobId, status: "QUEUED" as const };
}

export async function requestClipThumbnail(deps: ClipServiceDeps, clipId: string) {
  const clip = await ownedClip(deps, clipId);
  const jobId = await deps.enqueue({
    videoId: clip.videoId,
    kind: "THUMBNAIL",
    payload: { clipId },
  });
  return { jobId, status: "QUEUED" as const };
}

export async function updateClip(deps: ClipServiceDeps, clipId: string, input: unknown) {
  const patch = updateClipSchema.parse(input);
  const clip = await ownedClip(deps, clipId);

  const startMs = patch.startMs ?? clip.startMs;
  const endMs = patch.endMs ?? clip.endMs;
  if (endMs <= startMs) throw new ApiError(400, "endMs must be after startMs");

  await deps.db.clip.update({ where: { id: clipId }, data: patch });
  return { id: clipId, ...patch, startMs, endMs };
}

export async function deleteClip(deps: ClipServiceDeps, clipId: string) {
  await ownedClip(deps, clipId);
  await deps.db.clip.delete({ where: { id: clipId } });
  return { id: clipId, deleted: true };
}

export async function createManualClip(deps: ClipServiceDeps, videoId: string, input: unknown) {
  const { startMs, endMs, title } = manualClipSchema.parse(input);
  if (endMs <= startMs) throw new ApiError(400, "endMs must be after startMs");

  const video = await deps.db.video.findUnique({ where: { id: videoId } });
  await assertOwnsProject(deps, video?.projectId);

  const rows = await deps.db.transcriptSegment.findMany({ where: { transcript: { videoId } } });
  const durationMs = video?.durationMs ?? (rows.at(-1)?.endMs ?? endMs);

  let snappedStart = startMs;
  let snappedEnd = endMs;
  if (rows.length > 0) {
    const segments: Segment[] = rows.map((r) => ({ ...r, text: "", words: [] }));
    const snap = snapToSentences({ startMs, endMs }, segments, durationMs, DEFAULT_SNAP_CONFIG);
    snappedStart = snap.startMs;
    snappedEnd = snap.endMs;
  }

  const clip = await deps.db.clip.create({
    data: {
      videoId,
      origin: "USER_CREATED",
      startMs: snappedStart,
      endMs: snappedEnd,
      title: title ?? "Untitled clip",
      hashtags: [],
    },
  });
  return { id: clip.id, startMs: snappedStart, endMs: snappedEnd };
}

export async function listVideoClips(deps: ClipServiceDeps, videoId: string) {
  const video = await deps.db.video.findUnique({ where: { id: videoId } });
  await assertOwnsProject(deps, video?.projectId);

  const clips = await deps.db.clip.findMany({
    where: { videoId },
    orderBy: { startMs: "asc" },
    include: {
      subtitleConfig: {
        select: {
          preset: true,
          animation: true,
          textColor: true,
          highlightColor: true,
          positionY: true,
          uppercase: true,
        },
      },
      renders: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true, status: true, progress: true, outputKey: true },
      },
    },
  });
  return Promise.all(
    clips.map(async (c) => {
      const latest = c.renders[0];
      const [downloadUrl, thumbnailUrl] = await Promise.all([
        latest?.status === "COMPLETED" && latest.outputKey
          ? deps.storage.createDownloadUrl(latest.outputKey)
          : Promise.resolve(null),
        c.thumbnailKey ? deps.storage.createDownloadUrl(c.thumbnailKey) : Promise.resolve(null),
      ]);
      return {
        id: c.id,
        origin: c.origin,
        title: c.title,
        startMs: c.startMs,
        endMs: c.endMs,
        score: c.score,
        aspectRatio: c.aspectRatio,
        focalX: c.focalX,
        focalY: c.focalY,
        accepted: c.accepted,
        caption: c.caption,
        captions: c.subtitleConfig,
        thumbnailUrl,
        render: latest
          ? { id: latest.id, status: latest.status, progress: latest.progress, downloadUrl }
          : null,
      };
    }),
  );
}

export async function upsertCaptionConfig(deps: ClipServiceDeps, clipId: string, input: unknown) {
  const patch = captionConfigSchema.parse(input);
  await ownedClip(deps, clipId);
  const saved = await deps.db.subtitleConfig.upsert({
    where: { clipId },
    create: { clipId, ...patch },
    update: patch,
  });
  return saved;
}

export async function deleteCaptionConfig(deps: ClipServiceDeps, clipId: string) {
  await ownedClip(deps, clipId);
  const res = await deps.db.subtitleConfig.deleteMany({ where: { clipId } });
  return { clipId, removed: res.count > 0 };
}
