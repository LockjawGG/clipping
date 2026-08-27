import { z } from "zod";

import type { StorageProvider } from "../providers/types.ts";
import { ApiError } from "./http.ts";

/**
 * Clip actions: kick off a render, and list a video's clips (with their latest
 * render) for the detail page. Same injectable-deps shape as the video service.
 */

export const renderRequestSchema = z.object({
  quality: z.enum(["P720", "P1080", "ORIGINAL"]).default("P1080"),
  aspectRatio: z
    .enum(["VERTICAL_9_16", "SQUARE_1_1", "LANDSCAPE_16_9", "PORTRAIT_4_5"])
    .optional(),
});

interface ClipRow {
  id: string;
  videoId: string;
}

interface ClipListRow {
  id: string;
  title: string;
  startMs: number;
  endMs: number;
  score: number | null;
  aspectRatio: string;
  renders: Array<{ id: string; status: string; progress: number; outputKey: string | null }>;
}

export interface ClipDb {
  clip: {
    findUnique(args: { where: { id: string } }): Promise<ClipRow | null>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
    findMany(args: { where: { videoId: string } }): Promise<ClipListRow[]>;
  };
  video: {
    findUnique(args: { where: { id: string } }): Promise<{ projectId: string } | null>;
  };
  render: { create(args: { data: Record<string, unknown> }): Promise<{ id: string }> };
}

export interface ClipServiceDeps {
  db: ClipDb;
  storage: StorageProvider;
  ensureProject: () => Promise<string>;
  enqueue: (input: { videoId: string; kind: "RENDER"; payload?: unknown }) => Promise<string>;
}

async function ownedClip(deps: ClipServiceDeps, clipId: string): Promise<ClipRow> {
  const clip = await deps.db.clip.findUnique({ where: { id: clipId } });
  if (!clip) throw new ApiError(404, "clip not found");
  const [video, projectId] = await Promise.all([
    deps.db.video.findUnique({ where: { id: clip.videoId } }),
    deps.ensureProject(),
  ]);
  if (!video || video.projectId !== projectId) throw new ApiError(404, "clip not found");
  return clip;
}

export async function requestRender(deps: ClipServiceDeps, clipId: string, input: unknown) {
  const { quality, aspectRatio } = renderRequestSchema.parse(input);
  const clip = await ownedClip(deps, clipId);

  if (aspectRatio) {
    await deps.db.clip.update({ where: { id: clipId }, data: { aspectRatio } });
  }

  const render = await deps.db.render.create({
    data: { clipId, quality, status: "QUEUED", progress: 0 },
  });
  // The RENDER handler keys off renderId.
  const jobId = await deps.enqueue({
    videoId: clip.videoId,
    kind: "RENDER",
    payload: { renderId: render.id },
  });

  return { renderId: render.id, jobId, status: "QUEUED" as const };
}

export async function listVideoClips(deps: ClipServiceDeps, videoId: string) {
  const [video, projectId] = await Promise.all([
    deps.db.video.findUnique({ where: { id: videoId } }),
    deps.ensureProject(),
  ]);
  if (!video || video.projectId !== projectId) throw new ApiError(404, "video not found");

  const clips = await deps.db.clip.findMany({ where: { videoId } });
  return Promise.all(
    clips.map(async (c) => {
      const latest = c.renders[0];
      const downloadUrl =
        latest?.status === "COMPLETED" && latest.outputKey
          ? await deps.storage.createDownloadUrl(latest.outputKey)
          : null;
      return {
        id: c.id,
        title: c.title,
        startMs: c.startMs,
        endMs: c.endMs,
        score: c.score,
        aspectRatio: c.aspectRatio,
        render: latest ? { id: latest.id, status: latest.status, progress: latest.progress, downloadUrl } : null,
      };
    }),
  );
}
