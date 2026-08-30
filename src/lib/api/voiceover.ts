/**
 * Voiceover creation and status.
 *
 * A voiceover is generated once and then *re-anchored* on every render, so this
 * surface is small: create or update the settings, queue synthesis, read status.
 * Nothing here decides where the narration sits — that is resolved at render
 * time from the clip's current timing.
 */

import { z } from "zod";

import type { JobKind } from "../jobs/types.ts";
import { ApiError } from "./http.ts";
import { parseLines } from "../voiceover/sync.ts";

export const voiceoverSchema = z
  .object({
    sourceKind: z.enum(["TRANSCRIPT", "CAPTIONS", "SCRIPT"]),
    script: z.string().max(20_000).nullable(),
    language: z.string().min(2).max(12),
    voiceId: z.string().max(120),
    speed: z.number().min(0.5).max(2),
    duckDb: z.number().min(-40).max(0),
  })
  .partial()
  .strict();

interface Db {
  clip: {
    findUnique(args: {
      where: { id: string };
      select: Record<string, unknown>;
    }): Promise<{ id: string; video: { projectId: string } } | null>;
  };
  voiceover: {
    findFirst(args: { where: Record<string, unknown>; orderBy?: unknown }): Promise<VoiceoverRow | null>;
    create(args: { data: Record<string, unknown> }): Promise<VoiceoverRow>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<VoiceoverRow>;
    delete(args: { where: { id: string } }): Promise<unknown>;
  };
}

export interface VoiceoverRow {
  id: string;
  clipId: string;
  sourceKind: string;
  script: string | null;
  language: string;
  voiceId: string;
  speed: number;
  duckDb: number;
  linesJson: string | null;
  status: string;
  errorMessage: string | null;
}

export interface VoiceoverServiceDeps {
  db: Db;
  assertProjectOwned: (projectId: string) => Promise<void>;
  enqueue: (input: { videoId: string; kind: JobKind; payload?: unknown }) => Promise<string>;
}

async function ownedClip(deps: VoiceoverServiceDeps, clipId: string) {
  const clip = await deps.db.clip.findUnique({
    where: { id: clipId },
    select: { id: true, videoId: true, video: { select: { projectId: true } } },
  });
  if (!clip) throw new ApiError(404, "not found");
  await deps.assertProjectOwned(clip.video.projectId);
  return clip as { id: string; videoId: string; video: { projectId: string } };
}

export interface VoiceoverView extends VoiceoverRow {
  /** How many lines have been synthesized so far. */
  lineCount: number;
}

const view = (row: VoiceoverRow): VoiceoverView => ({
  ...row,
  lineCount: parseLines(row.linesJson).length,
});

export async function getVoiceover(
  deps: VoiceoverServiceDeps,
  clipId: string,
): Promise<VoiceoverView | null> {
  await ownedClip(deps, clipId);
  const row = await deps.db.voiceover.findFirst({
    where: { clipId },
    orderBy: { updatedAt: "desc" },
  });
  return row ? view(row) : null;
}

/**
 * Create or update the clip's voiceover and queue synthesis.
 *
 * Existing lines are kept: the handler re-synthesizes only what is new or whose
 * text changed, so tweaking the speed does not redo every line.
 */
export async function upsertVoiceover(
  deps: VoiceoverServiceDeps,
  clipId: string,
  input: unknown,
): Promise<VoiceoverView> {
  const patch = voiceoverSchema.parse(input ?? {});
  const clip = await ownedClip(deps, clipId);

  const existing = await deps.db.voiceover.findFirst({
    where: { clipId },
    orderBy: { updatedAt: "desc" },
  });

  const row = existing
    ? await deps.db.voiceover.update({
        where: { id: existing.id },
        data: { ...patch, status: "QUEUED", errorMessage: null },
      })
    : await deps.db.voiceover.create({ data: { clipId, ...patch, status: "QUEUED" } });

  await deps.enqueue({
    videoId: clip.videoId,
    kind: "VOICEOVER",
    payload: { voiceoverId: row.id },
  });
  return view(row);
}

export async function deleteVoiceover(
  deps: VoiceoverServiceDeps,
  clipId: string,
): Promise<{ removed: boolean }> {
  await ownedClip(deps, clipId);
  const existing = await deps.db.voiceover.findFirst({ where: { clipId } });
  if (!existing) return { removed: false };
  await deps.db.voiceover.delete({ where: { id: existing.id } });
  return { removed: true };
}
