/**
 * Voiceover creation and status.
 *
 * A voiceover is generated once and then *re-anchored* on every render, so this
 * surface is small: create or update the settings, queue synthesis, read status.
 * Nothing here decides where the narration *will* sit — that is resolved at
 * render time from the clip's current timing. Reading it back does resolve the
 * placement, through the very same `placeLines` the renderer uses, so the
 * preview can play the narration where the export will put it.
 */

import { z } from "zod";

import type { JobKind } from "../jobs/types.ts";
import { ApiError } from "./http.ts";
import { parseLines, placeLines } from "../voiceover/sync.ts";

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
  transcriptSegment: {
    findMany(args: {
      where: Record<string, unknown>;
      orderBy?: unknown;
    }): Promise<Array<{ startMs: number; endMs: number }>>;
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
  /** For handing the preview a playable URL per line. */
  storage: { createDownloadUrl(key: string): Promise<string> };
  assertProjectOwned: (projectId: string) => Promise<void>;
  enqueue: (input: { videoId: string; kind: JobKind; payload?: unknown }) => Promise<string>;
}

async function ownedClip(deps: VoiceoverServiceDeps, clipId: string) {
  const clip = await deps.db.clip.findUnique({
    where: { id: clipId },
    select: {
      id: true,
      videoId: true,
      startMs: true,
      endMs: true,
      video: { select: { projectId: true } },
    },
  });
  if (!clip) throw new ApiError(404, "not found");
  await deps.assertProjectOwned(clip.video.projectId);
  return clip as unknown as {
    id: string;
    videoId: string;
    startMs: number;
    endMs: number;
    video: { projectId: string };
  };
}

export interface VoiceoverView extends VoiceoverRow {
  /** How many lines have been synthesized so far. */
  lineCount: number;
  /**
   * Where each line lands and how to play it, for the preview.
   *
   * Times are clip-relative, like every other preview coordinate. Empty until
   * synthesis has produced audio.
   */
  lines: PreviewLine[];
}

/** One line of narration, placed and playable. */
export interface PreviewLine {
  ref: string;
  /** Milliseconds from the start of the clip. */
  startMs: number;
  /** How long it occupies once the tempo fit is applied. */
  playedMs: number;
  /** Playback rate that makes it fit its window. 1 = untouched. */
  tempo: number;
  url: string;
}

const view = (row: VoiceoverRow, lines: PreviewLine[] = []): VoiceoverView => ({
  ...row,
  lineCount: parseLines(row.linesJson).length,
  lines,
});

export async function getVoiceover(
  deps: VoiceoverServiceDeps,
  clipId: string,
): Promise<VoiceoverView | null> {
  const clip = await ownedClip(deps, clipId);
  const row = await deps.db.voiceover.findFirst({
    where: { clipId },
    orderBy: { updatedAt: "desc" },
  });
  if (!row) return null;
  return view(row, await previewLines(deps, clip, row));
}

/**
 * Resolve the stored lines onto the clip, ready to play.
 *
 * Deliberately the same anchoring the renderer does — segments that overlap the
 * clip, indexed in order, `script:` lines spread evenly — run through the same
 * `placeLines`. Anything else and the preview would put narration somewhere the
 * export will not.
 */
async function previewLines(
  deps: VoiceoverServiceDeps,
  clip: { videoId: string; startMs: number; endMs: number },
  row: VoiceoverRow,
): Promise<PreviewLine[]> {
  const stored = parseLines(row.linesJson);
  if (stored.length === 0) return [];
  const clipMs = Math.max(1, clip.endMs - clip.startMs);

  const segments = await deps.db.transcriptSegment.findMany({
    where: { transcript: { videoId: clip.videoId, translatedTo: "" } },
    orderBy: { index: "asc" },
  });
  const inClip = segments.filter((sg) => sg.endMs > clip.startMs && sg.startMs < clip.endMs);
  const anchors = inClip.map((sg, i) => ({
    ref: `seg:${i}`,
    startMs: Math.max(0, sg.startMs - clip.startMs),
    endMs: Math.max(0, sg.endMs - clip.startMs),
  }));
  const scriptAnchors = stored
    .filter((l) => l.ref.startsWith("script:"))
    .map((l, i, all) => {
      const step = clipMs / Math.max(1, all.length);
      return { ref: l.ref, startMs: Math.round(i * step), endMs: Math.round((i + 1) * step) };
    });

  const placed = placeLines(stored, [...anchors, ...scriptAnchors], { durationMs: clipMs });
  return Promise.all(
    placed.map(async (p) => ({
      ref: p.ref,
      startMs: p.startMs,
      playedMs: p.playedMs,
      tempo: p.tempo,
      url: await deps.storage.createDownloadUrl(p.audioKey),
    })),
  );
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
