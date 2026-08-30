/**
 * Profile aggregation: many feature vectors -> one learned style.
 *
 * This is decision D1 in code. It is an aggregate, not a network, and that
 * choice buys four things a learned model would not have given at this data
 * volume: it works from three examples, it retrains in under a second, it is
 * exportable as JSON, and — the requirement that actually forced the decision —
 * it can state in plain language what it learned, which is what lets every
 * suggestion explain itself.
 *
 * Pure. No I/O, no dependencies.
 */

import type { ContentType, StyleFeatures } from "./features.ts";

/** One categorical option with the share of examples that used it. */
export interface Ranked {
  value: string;
  /** 0..1 share of the weighted total. */
  share: number;
}

export interface StyleProfile {
  version: 1;
  contentType: ContentType;
  exampleCount: number;
  /** 0..1 — how much this profile should be trusted to bias anything. */
  confidence: number;
  pacing: {
    /** Weighted median clip length, and the middle-50% band around it. */
    medianMs: number;
    p25Ms: number;
    p75Ms: number;
    /** Share of edits where words were struck out. */
    trimShare: number;
  };
  captions: {
    /** Share of edits that had captions on at all. */
    useShare: number;
    template: Ranked[];
    animation: Ranked[];
    fontFamily: Ranked[];
    medianFontSizePx: number | null;
    medianPositionY: number | null;
    highlightShare: number;
  };
  motion: {
    intro: Ranked[];
    loop: Ranked[];
    outro: Ranked[];
    medianOverlayCount: number;
  };
  framing: {
    aspectRatio: Ranked[];
    captureWindowShare: number;
    medianMaxZoom: number;
  };
  polish: {
    censorShare: number;
  };
}

export interface WeightedExample {
  features: StyleFeatures;
  /** Base weight from the row; recency is applied on top. */
  weight?: number;
  createdAt?: Date | string | number;
}

/**
 * Recency half-life. Taste drifts, and last month's edits should outrank last
 * year's — but slowly enough that a user who takes a break does not lose their
 * profile.
 */
export const HALF_LIFE_DAYS = 90;

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

export function recencyWeight(createdAt: Date | string | number | undefined, now = Date.now()): number {
  if (createdAt === undefined) return 1;
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return 1;
  const days = Math.max(0, (now - t) / 86_400_000);
  return Math.pow(0.5, days / HALF_LIFE_DAYS);
}

/** Weighted quantile over (value, weight) pairs. */
function weightedQuantile(pairs: Array<[number, number]>, q: number): number | null {
  const valid = pairs.filter(([v, w]) => Number.isFinite(v) && w > 0);
  if (valid.length === 0) return null;
  valid.sort((a, b) => a[0] - b[0]);
  const total = valid.reduce((acc, [, w]) => acc + w, 0);
  const target = clamp01(q) * total;
  let seen = 0;
  for (const [v, w] of valid) {
    seen += w;
    if (seen >= target) return v;
  }
  return valid[valid.length - 1][0];
}

/** Weighted share of examples where `pick` is true. */
function share(examples: WeightedExample[], weights: number[], pick: (f: StyleFeatures) => boolean): number {
  let hit = 0;
  let total = 0;
  examples.forEach((e, i) => {
    total += weights[i];
    if (pick(e.features)) hit += weights[i];
  });
  return total > 0 ? clamp01(hit / total) : 0;
}

/** Rank categorical values by weighted share, strongest first. */
function rank(
  examples: WeightedExample[],
  weights: number[],
  pick: (f: StyleFeatures) => Record<string, number> | string | null | undefined,
  limit = 5,
): Ranked[] {
  const totals = new Map<string, number>();
  let grand = 0;
  examples.forEach((e, i) => {
    const got = pick(e.features);
    if (!got) return;
    if (typeof got === "string") {
      totals.set(got, (totals.get(got) ?? 0) + weights[i]);
      grand += weights[i];
      return;
    }
    for (const [key, count] of Object.entries(got)) {
      if (!count) continue;
      const w = weights[i] * count;
      totals.set(key, (totals.get(key) ?? 0) + w);
      grand += w;
    }
  });
  if (grand <= 0) return [];
  return [...totals.entries()]
    .map(([value, w]) => ({ value, share: clamp01(w / grand) }))
    .sort((a, b) => b.share - a.share)
    .slice(0, limit);
}

/**
 * Confidence combines how much evidence there is with how consistent it is.
 *
 * Both halves matter. Twenty examples that disagree about everything should not
 * bias anything, and neither should three that happen to agree. The count term
 * saturates around a dozen examples; the agreement term is the share held by
 * the single most-used caption template, which is a decent proxy for "this user
 * has a settled style" without needing every field to agree.
 */
export function computeConfidence(exampleCount: number, topTemplateShare: number): number {
  const evidence = clamp01(exampleCount / 12);
  const agreement = clamp01(topTemplateShare);
  // Weighted toward evidence: consistency means little without volume.
  return clamp01(0.65 * evidence + 0.35 * evidence * agreement);
}

/** Build the learned profile for one content type. */
export function buildProfile(
  contentType: ContentType,
  examples: WeightedExample[],
  now = Date.now(),
): StyleProfile {
  const weights = examples.map((e) => Math.max(0, (e.weight ?? 1) * recencyWeight(e.createdAt, now)));

  const durations: Array<[number, number]> = examples.map((e, i) => [
    e.features.pacing.durationMs,
    weights[i],
  ]);
  const fontSizes: Array<[number, number]> = examples
    .map((e, i) => [e.features.captions.fontSizePx ?? NaN, weights[i]] as [number, number])
    .filter(([v]) => Number.isFinite(v));
  const positions: Array<[number, number]> = examples
    .map((e, i) => [e.features.captions.positionY ?? NaN, weights[i]] as [number, number])
    .filter(([v]) => Number.isFinite(v));
  const overlayCounts: Array<[number, number]> = examples.map((e, i) => [
    e.features.motion.overlayCount,
    weights[i],
  ]);
  const zooms: Array<[number, number]> = examples.map((e, i) => [
    e.features.framing.maxZoom,
    weights[i],
  ]);

  const template = rank(examples, weights, (f) => f.captions.templateId);
  const confidence = computeConfidence(examples.length, template[0]?.share ?? 0);

  return {
    version: 1,
    contentType,
    exampleCount: examples.length,
    confidence,
    pacing: {
      medianMs: weightedQuantile(durations, 0.5) ?? 0,
      p25Ms: weightedQuantile(durations, 0.25) ?? 0,
      p75Ms: weightedQuantile(durations, 0.75) ?? 0,
      trimShare: share(examples, weights, (f) => f.pacing.trimmed),
    },
    captions: {
      useShare: share(examples, weights, (f) => f.captions.used),
      template,
      animation: rank(examples, weights, (f) => f.captions.animation),
      fontFamily: rank(examples, weights, (f) => f.captions.fontFamily),
      medianFontSizePx: weightedQuantile(fontSizes, 0.5),
      medianPositionY: weightedQuantile(positions, 0.5),
      highlightShare: share(examples, weights, (f) => f.captions.highlight),
    },
    motion: {
      intro: rank(examples, weights, (f) => f.motion.intro),
      loop: rank(examples, weights, (f) => f.motion.loop),
      outro: rank(examples, weights, (f) => f.motion.outro),
      medianOverlayCount: weightedQuantile(overlayCounts, 0.5) ?? 0,
    },
    framing: {
      aspectRatio: rank(examples, weights, (f) => f.framing.aspectRatio),
      captureWindowShare: share(examples, weights, (f) => f.framing.captureWindow),
      medianMaxZoom: weightedQuantile(zooms, 0.5) ?? 1,
    },
    polish: {
      censorShare: share(examples, weights, (f) => f.polish.censored),
    },
  };
}

/** An empty profile — the shape callers get before anything has been learned. */
export function emptyProfile(contentType: ContentType): StyleProfile {
  return buildProfile(contentType, []);
}

export function parseProfile(json: unknown): StyleProfile | null {
  const p = typeof json === "string" ? safeJson(json) : json;
  if (!p || typeof p !== "object") return null;
  const prof = p as Partial<StyleProfile>;
  if (prof.version !== 1 || !prof.pacing || !prof.captions) return null;
  return prof as StyleProfile;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
