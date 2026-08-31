import { z } from "zod";

import type { Segment, StorageProvider } from "../providers/types.ts";
import { DEFAULT_SNAP_CONFIG, snapToSentences } from "../clips/boundaries.ts";
import { CAPTION_ANIMATIONS } from "../captions/presets.ts";
import { serializeFocusTrack } from "../focus/keyframes.ts";
import { parseWordOverrides, serializeWordOverrides } from "../censor/overrides.ts";
import { learnedDefaults } from "../learning/apply.ts";
import type { StyleProfile } from "../learning/profile.ts";
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
    /** An authored capture window. Accepted as keyframes and stored as JSON;
     *  re-parsed defensively by `parseFocusTrack` at render time. Null clears. */
    focusTrack: z
      .array(
        z.object({
          atMs: z.number().nonnegative(),
          x: z.number().min(0).max(1),
          y: z.number().min(0).max(1),
          scale: z.number().min(1).max(4).optional(),
          ease: z.enum(["linear", "in", "out", "inOut", "spring"]).optional(),
        }),
      )
      .max(400)
      .nullable(),
    censorEnabled: z.boolean(),
    censorSensitivity: z.enum(["LOW", "MEDIUM", "HIGH"]),
    censorCaptionMode: z.enum(["FULL", "PARTIAL", "FIRST", "CUSTOM"]),
    censorAudioEnabled: z.boolean(),
    censorAudioMode: z.enum(["MUTE", "BEEP", "TONE"]),
    censorReplacement: z.string().max(40).nullable(),
    censorAllowList: z.array(z.string().min(1).max(60)).max(500),
    censorDenyList: z.array(z.string().min(1).max(60)).max(500),
    /** Per-occurrence overrides, as transcript word ids. */
    censorExemptWordIds: z.array(z.string().min(1).max(64)).max(5000),
    censorForceWordIds: z.array(z.string().min(1).max(64)).max(5000),
    /** The same overrides for the audio half of censoring. */
    censorAudioExemptWordIds: z.array(z.string().min(1).max(64)).max(5000),
    censorAudioForceWordIds: z.array(z.string().min(1).max(64)).max(5000),
    /** Per-occurrence settings, keyed by word id. Stored as JSON. */
    censorWordOverrides: z
      .record(
        z.string().min(1).max(64),
        z
          .object({
            audioMode: z.enum(["MUTE", "BEEP", "TONE"]).optional(),
            captionMode: z.enum(["FULL", "PARTIAL", "FIRST", "CUSTOM"]).optional(),
            replacement: z.string().max(40).nullable().optional(),
          })
          .strict(),
      )
      .refine((r) => Object.keys(r).length <= 5000, "too many word overrides"),
    /**
     * Transcript word ids struck out of the middle of the clip. The renderer
     * cuts these stretches and closes the clip up around them, so this makes
     * the clip shorter — unlike censoring, which covers a word and does not.
     */
    removedWordIds: z.array(z.string().min(1).max(64)).max(5000),
    muted: z.boolean(),
    volume: z.number().min(0).max(2),
    playbackRate: z.number().min(0.25).max(4),
    accepted: z.boolean(),
    /** Project to file this clip under for the "Saved clips" rail; null unsaves. */
    savedToProjectId: z.string().min(1).nullable(),
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
    outlineWidthPx: z.number().int().min(0).max(24),
    backgroundColor: hexColor.nullable(),
    alignment: z.enum(["left", "center", "right"]),
    positionY: z.number().min(0).max(1),
    maxLines: z.number().int().min(1).max(3),
    maxWordsPerCue: z.number().int().min(2).max(12),
    uppercase: z.boolean(),
    /** JSON-serialised partial TextStyle (fill, effect layers, letterSpacing…). */
    styleJson: z.string().max(20000).nullable(),
    /** JSON-serialised WordRule[]. */
    wordRulesJson: z.string().max(8000).nullable(),
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
  focusTrackJson: string | null;
  censorEnabled: boolean;
  censorSensitivity: "LOW" | "MEDIUM" | "HIGH";
  censorCaptionMode: "FULL" | "PARTIAL" | "FIRST" | "CUSTOM";
  censorAudioEnabled: boolean;
  censorAudioMode: "MUTE" | "BEEP" | "TONE";
  censorReplacement: string | null;
  censorAllowList: string[];
  censorDenyList: string[];
  censorExemptWordIds: string[];
  censorForceWordIds: string[];
  censorAudioExemptWordIds: string[];
  censorAudioForceWordIds: string[];
  censorWordOverridesJson: string | null;
  removedWordIds: string[];
  accepted: boolean;
  savedToProjectId: string | null;
  caption: string | null;
  hook: string | null;
  socialTitle: string | null;
  hashtags: string[];
  reason: string | null;
  thumbnailKey: string | null;
  subtitleConfig: {
    preset: string;
    animation: string;
    fontFamily: string;
    fontSizePx: number;
    fontWeight: number;
    textColor: string;
    highlightColor: string;
    outlineColor: string;
    outlineWidthPx: number;
    backgroundColor: string | null;
    alignment: string;
    positionY: number;
    maxLines: number;
    maxWordsPerCue: number;
    uppercase: boolean;
    styleJson: string | null;
    wordRulesJson: string | null;
  } | null;
  renders: Array<{
    id: string;
    status: string;
    progress: number;
    outputKey: string | null;
    quality: string;
    sizeBytes: bigint | null;
    durationMs: number | null;
    startedAt: Date | null;
  }>;
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
  voiceover?: {
    findFirst(args: {
      where: Record<string, unknown>;
      orderBy?: unknown;
      select?: unknown;
    }): Promise<{ id: string; sourceKind: string } | null>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
  };
  video: {
    findUnique(args: {
      where: { id: string };
    }): Promise<{ projectId: string; durationMs: number | null; contentType?: string } | null>;
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
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
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
  /** Throws 404 unless the project is owned by the signed-in user. */
  assertProjectOwned: (projectId: string) => Promise<void>;
  /**
   * The learned style for a content type, when one has been built. Optional so
   * a caller that does not care about learning (or a test) can leave it out —
   * an absent profile simply means no defaults are applied.
   */
  loadProfile?: (contentType: string) => Promise<StyleProfile | null>;
  enqueue: (input: {
    videoId: string;
    kind: "RENDER" | "THUMBNAIL" | "VOICEOVER";
    payload?: unknown;
  }) => Promise<string>;
  /**
   * Whether a render still has a job that could finish it.
   *
   * Absent means "assume it does", which is the old behaviour and what a test
   * that does not care about orphans wants.
   */
  renderJobAlive?: (renderId: string) => Promise<boolean>;
}

async function assertOwnsProject(deps: ClipServiceDeps, projectId: string | undefined | null): Promise<void> {
  if (!projectId) throw new ApiError(404, "not found");
  await deps.assertProjectOwned(projectId);
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
    // ...unless nothing is going to finish it. A render row is only ever
    // advanced by its job, so if that job is gone or already terminal the row
    // is stranded, and this clip could never be rendered again: every attempt
    // would keep pointing at a render that is not running. The queue's own
    // lease recovers a *job* whose worker died; nothing recovers the row it
    // left behind.
    const alive = (await deps.renderJobAlive?.(inFlight.id)) ?? true;
    if (alive) {
      return { renderId: inFlight.id, jobId: null, status: inFlight.status, alreadyRunning: true };
    }
    await deps.db.render.update({
      where: { id: inFlight.id },
      data: {
        status: "FAILED",
        errorMessage: "the worker stopped before this render finished",
        finishedAt: new Date(),
      },
    });
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

/**
 * Clip settings the narration is spoken through; changing one re-records it.
 *
 * The per-occurrence lists are here for the same reason the term lists are.
 * Narration read from the transcript is judged word by word on the audio axis,
 * so ticking a single word in the transcript changes what the voice says — and
 * without that re-record the clip bleeps the word while the narration reads it
 * out, which is the whole point of censoring lost.
 */
const CENSOR_FIELDS = [
  "censorEnabled",
  "censorSensitivity",
  "censorAllowList",
  "censorDenyList",
  "censorAudioMode",
  "censorAudioEnabled",
  "censorExemptWordIds",
  "censorForceWordIds",
  "censorAudioExemptWordIds",
  "censorAudioForceWordIds",
  "censorWordOverrides",
] as const satisfies readonly (keyof z.infer<typeof updateClipSchema>)[];

export async function updateClip(deps: ClipServiceDeps, clipId: string, input: unknown) {
  const patch = updateClipSchema.parse(input);
  const clip = await ownedClip(deps, clipId);

  const startMs = patch.startMs ?? clip.startMs;
  const endMs = patch.endMs ?? clip.endMs;
  if (endMs <= startMs) throw new ApiError(400, "endMs must be after startMs");

  if (patch.savedToProjectId) await deps.assertProjectOwned(patch.savedToProjectId);

  // The capture window arrives as keyframes and is stored as JSON. Normalising
  // through the same parser the renderer uses means what is saved is exactly
  // what will be rendered — sorted, clamped, and with defaults filled in.
  const { focusTrack, censorWordOverrides, ...rest } = patch;
  const data: Record<string, unknown> = { ...rest };
  if (focusTrack !== undefined) {
    data.focusTrackJson = focusTrack === null ? null : serializeFocusTrack(focusTrack);
  }
  // Normalised through the same serialiser the renderer parses, so empty
  // entries never reach the column and "nothing overridden" is always null.
  if (censorWordOverrides !== undefined) {
    data.censorWordOverridesJson = serializeWordOverrides(censorWordOverrides);
  }

  await deps.db.clip.update({ where: { id: clipId }, data });

  /**
   * Narration is censored while it is being spoken — a bleeped word is never
   * recorded, so the settings are baked into the audio. Change them and the
   * stored lines are wrong: the clip bleeps the word while the voice reads it
   * out, which is the opposite of what censoring is for. Re-running the
   * synthesis re-records only the lines whose censoring actually changed.
   */
  const censorTouched = CENSOR_FIELDS.some((f) => patch[f] !== undefined);
  if (censorTouched && deps.db.voiceover) {
    const vo = await deps.db.voiceover.findFirst({
      where: { clipId },
      orderBy: { updatedAt: "desc" },
      select: { id: true, sourceKind: true },
    });
    // A script is written by hand and is not derived from the transcript, so
    // the clip's word lists have nothing to say about it.
    if (vo && vo.sourceKind !== "SCRIPT") {
      // Marked QUEUED here, not just when the worker picks it up: the panel
      // polls only while the row says it is running, so without this it reads
      // COMPLETED with the old lines once and stops looking.
      await deps.db.voiceover.update({
        where: { id: vo.id },
        data: { status: "QUEUED", errorMessage: null },
      });
      await deps.enqueue({
        videoId: clip.videoId,
        kind: "VOICEOVER",
        payload: { voiceoverId: vo.id },
      });
    }
  }

  return { id: clipId, ...patch, startMs, endMs };
}

export async function deleteClip(deps: ClipServiceDeps, clipId: string) {
  await ownedClip(deps, clipId);
  await deps.db.clip.delete({ where: { id: clipId } });
  return { id: clipId, deleted: true };
}

/** Everything a new clip can carry, whatever created it. */
export interface NewClipInput {
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
}

export interface CreatedClip {
  id: string;
  startMs: number;
  endMs: number;
  /** Fields the learned profile filled in, for the UI to mention. */
  appliedDefaults: string[];
}

/**
 * The one clip-creation path.
 *
 * Both the manual "new clip" button and an accepted worker highlight come
 * through here, so sentence snapping and learned defaults apply identically to
 * each. Two creation paths would have drifted.
 */
export async function createClipFromRange(
  deps: ClipServiceDeps,
  videoId: string,
  input: NewClipInput,
): Promise<CreatedClip> {
  if (input.endMs <= input.startMs) throw new ApiError(400, "endMs must be after startMs");

  const video = await deps.db.video.findUnique({ where: { id: videoId } });
  await assertOwnsProject(deps, video?.projectId);

  const rows = await deps.db.transcriptSegment.findMany({ where: { transcript: { videoId } } });
  const durationMs = video?.durationMs ?? (rows.at(-1)?.endMs ?? input.endMs);

  // Snap to sentence boundaries so a clip never opens or closes mid-word.
  let snappedStart = input.startMs;
  let snappedEnd = input.endMs;
  if (rows.length > 0) {
    const segments: Segment[] = rows.map((r) => ({ ...r, text: "", words: [] }));
    const snap = snapToSentences(
      { startMs: input.startMs, endMs: input.endMs },
      segments,
      durationMs,
      DEFAULT_SNAP_CONFIG,
    );
    snappedStart = snap.startMs;
    snappedEnd = snap.endMs;
  }

  // Learned defaults, if this user has a settled style for this kind of video.
  const profile = deps.loadProfile
    ? await deps.loadProfile(video?.contentType ?? "UNKNOWN").catch(() => null)
    : null;
  const defaults = learnedDefaults(profile);
  const appliedDefaults: string[] = [];

  const clip = await deps.db.clip.create({
    data: {
      videoId,
      origin: input.origin ?? "USER_CREATED",
      startMs: snappedStart,
      endMs: snappedEnd,
      title: input.title ?? "Untitled clip",
      hook: input.hook ?? null,
      caption: input.caption ?? null,
      socialTitle: input.socialTitle ?? null,
      reason: input.reason ?? null,
      score: input.score ?? null,
      hashtags: input.hashtags ?? [],
      ...(defaults.aspectRatio ? { aspectRatio: defaults.aspectRatio } : {}),
    },
  });
  if (defaults.aspectRatio) appliedDefaults.push("aspect ratio");

  // Captions are a separate row, created only when the profile is confident the
  // user wants them — a clip with no SubtitleConfig renders without captions.
  if (defaults.captionsOn) {
    await deps.db.subtitleConfig.upsert({
      where: { clipId: clip.id },
      create: {
        clipId: clip.id,
        ...(defaults.captionAnimation ? { animation: defaults.captionAnimation } : {}),
        ...(defaults.fontFamily ? { fontFamily: defaults.fontFamily } : {}),
        ...(defaults.fontSizePx ? { fontSizePx: defaults.fontSizePx } : {}),
        ...(defaults.positionY !== undefined ? { positionY: defaults.positionY } : {}),
        ...(defaults.captionTemplateId
          ? { styleJson: JSON.stringify({ templateId: defaults.captionTemplateId }) }
          : {}),
      },
      update: {},
    });
    appliedDefaults.push("captions");
  }

  return { id: clip.id, startMs: snappedStart, endMs: snappedEnd, appliedDefaults };
}

export async function createManualClip(deps: ClipServiceDeps, videoId: string, input: unknown) {
  const { startMs, endMs, title } = manualClipSchema.parse(input);
  const created = await createClipFromRange(deps, videoId, {
    startMs,
    endMs,
    title,
    origin: "USER_CREATED",
  });
  return { id: created.id, startMs: created.startMs, endMs: created.endMs };
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
          fontFamily: true,
          fontSizePx: true,
          fontWeight: true,
          textColor: true,
          highlightColor: true,
          outlineColor: true,
          outlineWidthPx: true,
          backgroundColor: true,
          alignment: true,
          positionY: true,
          maxLines: true,
          maxWordsPerCue: true,
          uppercase: true,
          styleJson: true,
          wordRulesJson: true,
        },
      },
      renders: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          status: true,
          progress: true,
          outputKey: true,
          quality: true,
          sizeBytes: true,
          durationMs: true,
          startedAt: true,
        },
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
        focusTrackJson: c.focusTrackJson,
        censorEnabled: c.censorEnabled,
        // Stored as plain columns; the schema constrains the values on write.
        censorSensitivity: c.censorSensitivity as "LOW" | "MEDIUM" | "HIGH",
        censorCaptionMode: c.censorCaptionMode as "FULL" | "PARTIAL" | "FIRST" | "CUSTOM",
        censorAudioEnabled: c.censorAudioEnabled,
        censorAudioMode: c.censorAudioMode as "MUTE" | "BEEP" | "TONE",
        censorReplacement: c.censorReplacement,
        censorAllowList: c.censorAllowList,
        censorDenyList: c.censorDenyList,
        censorExemptWordIds: c.censorExemptWordIds,
        censorForceWordIds: c.censorForceWordIds,
        censorAudioExemptWordIds: c.censorAudioExemptWordIds,
        censorAudioForceWordIds: c.censorAudioForceWordIds,
        censorWordOverrides: parseWordOverrides(c.censorWordOverridesJson),
        removedWordIds: c.removedWordIds,
        accepted: c.accepted,
        savedToProjectId: c.savedToProjectId,
        caption: c.caption,
        hook: c.hook,
        socialTitle: c.socialTitle,
        hashtags: c.hashtags,
        reason: c.reason,
        captions: c.subtitleConfig
          ? {
              ...c.subtitleConfig,
              alignment: (["left", "right"].includes(c.subtitleConfig.alignment)
                ? c.subtitleConfig.alignment
                : "center") as "left" | "center" | "right",
            }
          : null,
        thumbnailUrl,
        render: latest
          ? {
              id: latest.id,
              status: latest.status,
              progress: latest.progress,
              downloadUrl,
              quality: latest.quality,
              sizeBytes: latest.sizeBytes != null ? Number(latest.sizeBytes) : null,
              durationMs: latest.durationMs,
              startedAtMs: latest.startedAt ? latest.startedAt.getTime() : null,
            }
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
