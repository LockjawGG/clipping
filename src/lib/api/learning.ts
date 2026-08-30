/**
 * The training repository and the profiles built from it.
 *
 * Approving a project for training is always explicit — an edit is not learned
 * from because it was rendered, but because the user said it was good. That
 * keeps the repository a curated set rather than a log of everything, including
 * the abandoned experiments.
 */

import { z } from "zod";

import { ApiError } from "./http.ts";
import { extractFeatures, parseFeatures, type ClipSnapshot, type ContentType } from "../learning/features.ts";
import { buildProfile, parseProfile, type StyleProfile } from "../learning/profile.ts";
import { explainProfile } from "../learning/apply.ts";
import { parseElementAnim } from "../captions/element-anim.ts";
import { parseFocusTrack } from "../focus/keyframes.ts";

export const CONTENT_TYPE_VALUES = [
  "PODCAST",
  "INTERVIEW",
  "GAMING",
  "COMMENTARY",
  "EDUCATIONAL",
  "NEWS",
  "VLOG",
  "SHORT",
  "LONGFORM",
  "UNKNOWN",
] as const;

export const approveTrainingSchema = z
  .object({
    contentType: z.enum(CONTENT_TYPE_VALUES).optional(),
  })
  .strict();

export const feedbackSchema = z
  .object({
    kind: z.string().min(1).max(40),
    action: z.enum(["ACCEPTED", "REJECTED", "MODIFIED"]),
    videoId: z.string().min(1).nullable().optional(),
    suggested: z.unknown(),
    final: z.unknown().optional(),
  })
  .strict();

/** Minimal Prisma surface, mirroring the other services here. */
interface Db {
  clip: {
    findUnique(args: { where: { id: string }; include?: unknown; select?: unknown }): Promise<ClipRow | null>;
  };
  trainingExample: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    findMany(args: {
      where: Record<string, unknown>;
      orderBy?: unknown;
      take?: number;
    }): Promise<ExampleRow[]>;
    delete(args: { where: { id: string } }): Promise<unknown>;
    count(args: { where: Record<string, unknown> }): Promise<number>;
  };
  styleProfile: {
    upsert(args: {
      where: Record<string, unknown>;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<unknown>;
    findMany(args: { where: Record<string, unknown> }): Promise<ProfileRow[]>;
    findUnique(args: { where: Record<string, unknown> }): Promise<ProfileRow | null>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<unknown>;
  };
  suggestionFeedback: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  };
}

interface ClipRow {
  id: string;
  startMs: number;
  endMs: number;
  aspectRatio: string;
  removedWordIds: string[];
  focusTrackJson: string | null;
  censorEnabled: boolean;
  video: { id: string; projectId: string; contentType: string };
  subtitleConfig: {
    animation: string;
    fontFamily: string;
    fontSizePx: number;
    positionY: number;
    styleJson: string | null;
    wordRulesJson: string | null;
  } | null;
  overlays: Array<{ kind: string; role: string; animationJson: string | null }>;
}

export interface ExampleRow {
  id: string;
  clipId: string | null;
  contentType: string;
  featureJson: unknown;
  weight: number;
  createdAt: Date;
}

export interface ProfileRow {
  contentType: string;
  profileJson: unknown;
  confidence: number;
  exampleCount: number;
  trainedAt: Date;
}

export interface LearningServiceDeps {
  db: Db;
  userId: string;
  assertProjectOwned: (projectId: string) => Promise<void>;
}

/** Cap on examples read into one profile build; recency makes older ones moot. */
export const MAX_EXAMPLES = 400;

/**
 * Turn a persisted clip into the snapshot the extractor reads.
 *
 * Kept here rather than in `learning/features.ts` so that module stays pure and
 * free of any knowledge of the database shape.
 */
export function snapshotFromClip(clip: ClipRow): ClipSnapshot {
  const focus = parseFocusTrack(clip.focusTrackJson);
  const sc = clip.subtitleConfig;
  return {
    startMs: clip.startMs,
    endMs: clip.endMs,
    aspectRatio: clip.aspectRatio,
    removedWordCount: clip.removedWordIds.length,
    focusKeyframeCount: focus.length,
    maxFocusScale: focus.reduce((m, k) => Math.max(m, k.scale), 1),
    censorEnabled: clip.censorEnabled,
    captions: sc
      ? {
          enabled: true,
          // The template id is stored in the rich style blob when one was applied.
          templateId: readTemplateId(sc.styleJson),
          animation: sc.animation,
          fontFamily: sc.fontFamily,
          fontSizePx: sc.fontSizePx,
          positionY: sc.positionY,
          highlightUsed: !!sc.wordRulesJson && sc.wordRulesJson !== "[]",
        }
      : null,
    overlays: clip.overlays.map((o) => {
      const anim = parseElementAnim(o.animationJson);
      return {
        kind: o.kind,
        role: o.role,
        intro: anim.intro ?? null,
        loop: anim.loop ?? null,
        outro: anim.outro ?? null,
      };
    }),
  };
}

function readTemplateId(styleJson: string | null): string | null {
  if (!styleJson) return null;
  try {
    const p = JSON.parse(styleJson) as { templateId?: unknown };
    return typeof p.templateId === "string" ? p.templateId : null;
  } catch {
    return null;
  }
}

async function ownedClip(deps: LearningServiceDeps, clipId: string): Promise<ClipRow> {
  const clip = await deps.db.clip.findUnique({
    where: { id: clipId },
    include: {
      video: { select: { id: true, projectId: true, contentType: true } },
      subtitleConfig: true,
      overlays: { select: { kind: true, role: true, animationJson: true } },
    },
  });
  if (!clip) throw new ApiError(404, "not found");
  await deps.assertProjectOwned(clip.video.projectId);
  return clip;
}

/**
 * Add a finished clip to the training repository.
 *
 * The feature vector is computed here, once, and stored — a later profile
 * rebuild is an aggregate over these small vectors and never re-reads the clip.
 */
export async function approveForTraining(
  deps: LearningServiceDeps,
  clipId: string,
  input: unknown,
): Promise<{ id: string; contentType: ContentType }> {
  const { contentType } = approveTrainingSchema.parse(input ?? {});
  const clip = await ownedClip(deps, clipId);

  const resolved = (contentType ?? clip.video.contentType ?? "UNKNOWN") as ContentType;
  const features = extractFeatures(snapshotFromClip(clip));

  const row = await deps.db.trainingExample.create({
    data: {
      userId: deps.userId,
      clipId: clip.id,
      contentType: resolved,
      featureJson: features as unknown as Record<string, unknown>,
    },
  });
  return { id: row.id, contentType: resolved };
}

export async function removeTrainingExample(
  deps: LearningServiceDeps,
  exampleId: string,
): Promise<{ removed: true }> {
  // Scoped by userId in the where clause, so another user's row is a no-op
  // rather than a leak.
  const rows = await deps.db.trainingExample.findMany({
    where: { id: exampleId, userId: deps.userId },
    take: 1,
  });
  if (rows.length === 0) throw new ApiError(404, "not found");
  await deps.db.trainingExample.delete({ where: { id: exampleId } });
  return { removed: true };
}

/**
 * Rebuild every profile from the repository.
 *
 * Fast enough to run inline: it reads a few hundred pre-extracted vectors and
 * aggregates them. It only becomes a queued job past a few thousand examples.
 */
export async function retrainProfiles(
  deps: LearningServiceDeps,
): Promise<{ profiles: Array<{ contentType: string; exampleCount: number; confidence: number }> }> {
  const rows = await deps.db.trainingExample.findMany({
    where: { userId: deps.userId },
    orderBy: { createdAt: "desc" },
    take: MAX_EXAMPLES,
  });

  const byType = new Map<string, ExampleRow[]>();
  for (const r of rows) {
    const list = byType.get(r.contentType) ?? [];
    list.push(r);
    byType.set(r.contentType, list);
  }

  const out: Array<{ contentType: string; exampleCount: number; confidence: number }> = [];
  for (const [contentType, list] of byType) {
    const examples = list
      .map((r) => ({ features: parseFeatures(r.featureJson), weight: r.weight, createdAt: r.createdAt }))
      // A vector written by an older extractor is skipped rather than guessed at.
      .filter((e): e is { features: NonNullable<ReturnType<typeof parseFeatures>>; weight: number; createdAt: Date } =>
        e.features !== null,
      );
    if (examples.length === 0) continue;

    const profile = buildProfile(contentType as ContentType, examples);
    await deps.db.styleProfile.upsert({
      where: { userId_contentType: { userId: deps.userId, contentType } },
      create: {
        userId: deps.userId,
        contentType,
        profileJson: profile as unknown as Record<string, unknown>,
        confidence: profile.confidence,
        exampleCount: profile.exampleCount,
      },
      update: {
        profileJson: profile as unknown as Record<string, unknown>,
        confidence: profile.confidence,
        exampleCount: profile.exampleCount,
        trainedAt: new Date(),
      },
    });
    out.push({
      contentType,
      exampleCount: profile.exampleCount,
      confidence: profile.confidence,
    });
  }
  return { profiles: out };
}

export interface RepositoryView {
  totalExamples: number;
  profiles: Array<{
    contentType: string;
    exampleCount: number;
    confidence: number;
    trainedAt: string;
    /** Plain-language account of what this profile learned. */
    learned: string[];
  }>;
}

/** The repository dashboard. */
export async function repositoryOverview(deps: LearningServiceDeps): Promise<RepositoryView> {
  const [totalExamples, rows] = await Promise.all([
    deps.db.trainingExample.count({ where: { userId: deps.userId } }),
    deps.db.styleProfile.findMany({ where: { userId: deps.userId } }),
  ]);

  return {
    totalExamples,
    profiles: rows
      .map((r) => {
        const profile = parseProfile(r.profileJson);
        return {
          contentType: r.contentType,
          exampleCount: r.exampleCount,
          confidence: r.confidence,
          trainedAt: r.trainedAt.toISOString(),
          learned: explainProfile(profile),
        };
      })
      .sort((a, b) => b.exampleCount - a.exampleCount),
  };
}

/** The profile for one content type, or null if it has never been built. */
export async function loadProfile(
  deps: LearningServiceDeps,
  contentType: string,
): Promise<StyleProfile | null> {
  const row = await deps.db.styleProfile.findUnique({
    where: { userId_contentType: { userId: deps.userId, contentType } },
  });
  return row ? parseProfile(row.profileJson) : null;
}

/** Record an accept / reject / modify. Fire-and-forget from the caller's view. */
export async function recordFeedback(
  deps: LearningServiceDeps,
  input: unknown,
): Promise<{ id: string }> {
  const parsed = feedbackSchema.parse(input);
  return deps.db.suggestionFeedback.create({
    data: {
      userId: deps.userId,
      videoId: parsed.videoId ?? null,
      kind: parsed.kind,
      action: parsed.action,
      suggestedJson: (parsed.suggested ?? {}) as Record<string, unknown>,
      finalJson: (parsed.final ?? null) as Record<string, unknown> | null,
    },
  });
}

/** Wipe the repository and every profile built from it. */
export async function clearTrainingData(
  deps: LearningServiceDeps,
): Promise<{ cleared: true }> {
  await deps.db.styleProfile.deleteMany({ where: { userId: deps.userId } });
  const rows = await deps.db.trainingExample.findMany({
    where: { userId: deps.userId },
    take: MAX_EXAMPLES,
  });
  for (const r of rows) await deps.db.trainingExample.delete({ where: { id: r.id } });
  return { cleared: true };
}
