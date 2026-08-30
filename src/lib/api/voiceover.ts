/**
 * Voiceover creation and status.
 *
 * A voiceover is generated once and then *re-anchored* on every render, so this
 * surface is small: create or update the settings, queue synthesis, read status,
 * and hand back a playable URL per line.
 *
 * It deliberately does not place the lines. Placement depends on the clip's
 * timeline and on which words are struck out, and the editor holds edits the
 * server has not been told about yet — anchoring here would put the preview's
 * narration where the *saved* clip would put it, which is a different clip from
 * the one on screen. The editor places them against the same plan it previews,
 * with the same `placeLines` the renderer uses.
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
    /** Mix the narration in, or leave it silent without discarding it. */
    enabled: z.boolean(),
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
  enabled: boolean;
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
   * The synthesized lines with something to play them from. Unplaced: the
   * caller anchors them. Empty until synthesis has produced audio.
   */
  lines: PreviewLine[];
}

/** One synthesized line, playable. */
export interface PreviewLine {
  /** The anchor it was generated from, e.g. `seg:3`. */
  ref: string;
  /** Length of the audio as synthesized, before any tempo fit. */
  durationMs: number;
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
  await ownedClip(deps, clipId);
  const row = await deps.db.voiceover.findFirst({
    where: { clipId },
    orderBy: { updatedAt: "desc" },
  });
  if (!row) return null;
  return view(row, await previewLines(deps, row));
}

/** The stored lines, each with a URL the browser can play. */
async function previewLines(
  deps: VoiceoverServiceDeps,
  row: VoiceoverRow,
): Promise<PreviewLine[]> {
  const stored = parseLines(row.linesJson);
  return Promise.all(
    stored.map(async (l) => ({
      ref: l.ref,
      durationMs: l.durationMs,
      url: await deps.storage.createDownloadUrl(l.audioKey),
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

  /**
   * Switching the narration on or off changes nothing about the audio, so it
   * must not cost a re-synthesis: flipping a switch would otherwise send the
   * whole clip back through Piper and leave the panel saying QUEUED for a
   * minute. Any other field is a real change to what gets spoken.
   */
  const onlyToggled =
    existing !== null &&
    Object.keys(patch).length > 0 &&
    Object.keys(patch).every((k) => k === "enabled");

  const row = existing
    ? await deps.db.voiceover.update({
        where: { id: existing.id },
        data: onlyToggled ? patch : { ...patch, status: "QUEUED", errorMessage: null },
      })
    : await deps.db.voiceover.create({ data: { clipId, ...patch, status: "QUEUED" } });

  if (!onlyToggled) {
    await deps.enqueue({
      videoId: clip.videoId,
      kind: "VOICEOVER",
      payload: { voiceoverId: row.id },
    });
  }
  return view(row, await previewLines(deps, row));
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
