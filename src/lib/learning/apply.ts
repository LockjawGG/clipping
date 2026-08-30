/**
 * Applying a learned profile.
 *
 * A profile never *decides* anything on its own. It biases three things:
 *
 *   1. the clip-length window handed to the analysis provider,
 *   2. the defaults a newly created clip starts with,
 *   3. a short preferences block appended to the LLM prompt,
 *
 * and it contributes a sentence of explanation to every suggestion it touched.
 * That last part is the whole justification for D1: a statistical profile can
 * say "you cut 82% of your podcast clips between 18 and 24 seconds", and a
 * learned network cannot.
 *
 * Everything here is gated on `confidence`. A profile built from two examples
 * must not quietly reshape the product.
 */

import type { StyleProfile } from "./profile.ts";

/** Below this, the profile is treated as not yet knowing anything. */
export const MIN_CONFIDENCE = 0.25;

export function isUsable(profile: StyleProfile | null | undefined): profile is StyleProfile {
  return !!profile && profile.confidence >= MIN_CONFIDENCE && profile.exampleCount > 0;
}

const secs = (ms: number) => Math.round(ms / 1000);

export interface ClipLengthBias {
  minClipMs: number;
  maxClipMs: number;
  /** The length to aim for; the scorer prefers candidates near it. */
  targetMs: number;
  /** Non-null when the profile actually supplied these. */
  learned: boolean;
}

/**
 * The clip-length window to ask the analysis provider for.
 *
 * Widened past the learned p25/p75 band rather than clamped to it: the profile
 * describes what the user has done, not a rule about what they may do, and a
 * hard clamp would stop the worker ever proposing a length that turns out to
 * suit the material.
 */
export function clipLengthBias(
  profile: StyleProfile | null | undefined,
  fallback: { minClipMs: number; maxClipMs: number },
): ClipLengthBias {
  if (!isUsable(profile) || profile.pacing.medianMs <= 0) {
    return {
      minClipMs: fallback.minClipMs,
      maxClipMs: fallback.maxClipMs,
      targetMs: Math.round((fallback.minClipMs + fallback.maxClipMs) / 2),
      learned: false,
    };
  }
  const { p25Ms, p75Ms, medianMs } = profile.pacing;
  const lo = Math.max(2000, Math.round(p25Ms * 0.7));
  const hi = Math.round(Math.max(p75Ms * 1.4, medianMs * 1.5));
  return {
    minClipMs: Math.min(lo, medianMs),
    maxClipMs: Math.max(hi, medianMs),
    targetMs: medianMs,
    learned: true,
  };
}

export interface LearnedDefaults {
  aspectRatio?: string;
  captionsOn?: boolean;
  captionTemplateId?: string;
  captionAnimation?: string;
  fontFamily?: string;
  fontSizePx?: number;
  positionY?: number;
}

/**
 * Defaults for a newly created clip.
 *
 * Only fields the user is clearly consistent about are filled in — a template
 * used in 30% of edits is not a preference, and pre-filling it would be worse
 * than leaving the global default alone.
 *
 * The comparison is strictly greater than: an exact 50/50 split between two
 * templates is a tie, not a favourite, and must decide nothing.
 */
export const DOMINANT_SHARE = 0.5;

export function learnedDefaults(profile: StyleProfile | null | undefined): LearnedDefaults {
  if (!isUsable(profile)) return {};
  const out: LearnedDefaults = {};

  const top = <T extends { value: string; share: number }>(list: T[]): string | undefined =>
    list[0] && list[0].share > DOMINANT_SHARE ? list[0].value : undefined;

  const aspect = top(profile.framing.aspectRatio);
  if (aspect) out.aspectRatio = aspect;

  if (profile.captions.useShare > DOMINANT_SHARE) {
    out.captionsOn = true;
    const template = top(profile.captions.template);
    if (template) out.captionTemplateId = template;
    const animation = top(profile.captions.animation);
    if (animation) out.captionAnimation = animation;
    const font = top(profile.captions.fontFamily);
    if (font) out.fontFamily = font;
    if (profile.captions.medianFontSizePx) out.fontSizePx = Math.round(profile.captions.medianFontSizePx);
    if (profile.captions.medianPositionY !== null) {
      out.positionY = Math.round(profile.captions.medianPositionY * 100) / 100;
    }
  } else if (profile.captions.useShare < 1 - DOMINANT_SHARE) {
    out.captionsOn = false;
  }

  return out;
}

/**
 * A compact preferences block for the analysis prompt.
 *
 * Kept to a handful of lines: the point is to steer the model's taste, not to
 * hand it a specification it will then follow literally at the expense of the
 * material. Returns null when there is nothing worth saying.
 */
export function promptBias(profile: StyleProfile | null | undefined): string | null {
  if (!isUsable(profile)) return null;
  const lines: string[] = [];

  if (profile.pacing.medianMs > 0) {
    lines.push(
      `- Preferred clip length: around ${secs(profile.pacing.medianMs)}s ` +
        `(most fall between ${secs(profile.pacing.p25Ms)}s and ${secs(profile.pacing.p75Ms)}s).`,
    );
  }
  if (profile.pacing.trimShare > DOMINANT_SHARE) {
    lines.push("- This editor trims filler aggressively; prefer tight, self-contained moments.");
  }
  const template = profile.captions.template[0];
  if (template && template.share > DOMINANT_SHARE) {
    lines.push(`- Usual caption style: ${template.value}.`);
  }
  if (profile.framing.captureWindowShare > DOMINANT_SHARE) {
    lines.push("- This editor punches in on the subject; favour moments with a clear focal point.");
  }

  if (lines.length === 0) return null;
  return ["Learned preferences for this editor (guidance, not rules):", ...lines].join("\n");
}

/**
 * Plain-language sentences describing what the profile learned.
 *
 * Used two ways: as the "why this suits you" clause on a suggestion, and as the
 * repository dashboard's account of itself. If this function cannot produce a
 * sentence, the profile has not learned anything worth acting on — which is a
 * useful thing to be able to check.
 */
export function explainProfile(profile: StyleProfile | null | undefined): string[] {
  if (!profile || profile.exampleCount === 0) return [];
  const out: string[] = [];
  const pct = (n: number) => `${Math.round(n * 100)}%`;

  if (profile.pacing.medianMs > 0) {
    out.push(
      `You cut most of these between ${secs(profile.pacing.p25Ms)}s and ` +
        `${secs(profile.pacing.p75Ms)}s, with a typical length of ${secs(profile.pacing.medianMs)}s.`,
    );
  }
  if (profile.captions.useShare > 0) {
    out.push(`Captions on ${pct(profile.captions.useShare)} of these edits.`);
  }
  const template = profile.captions.template[0];
  if (template) {
    out.push(`Most-used caption style: ${template.value} (${pct(template.share)}).`);
  }
  const anim = profile.captions.animation[0];
  if (anim) out.push(`Usual caption animation: ${anim.value} (${pct(anim.share)}).`);

  const loop = profile.motion.loop[0];
  if (loop) out.push(`Favourite continuous motion: ${loop.value} (${pct(loop.share)}).`);

  if (profile.framing.captureWindowShare > 0) {
    out.push(
      `Capture window used on ${pct(profile.framing.captureWindowShare)} of these` +
        (profile.framing.medianMaxZoom > 1
          ? `, typically punching in to ${profile.framing.medianMaxZoom.toFixed(1)}×.`
          : "."),
    );
  }
  if (profile.pacing.trimShare > 0) {
    out.push(`Filler trimmed on ${pct(profile.pacing.trimShare)} of these.`);
  }
  if (profile.polish.censorShare > 0) {
    out.push(`Censoring enabled on ${pct(profile.polish.censorShare)} of these.`);
  }
  return out;
}

/**
 * The one-line "why this suits you" clause for a suggestion of a given length.
 * Null when the profile has nothing relevant to say about it, which is the
 * common case early on and must read as silence rather than filler.
 */
export function explainLengthFit(
  profile: StyleProfile | null | undefined,
  startMs: number,
  endMs: number,
): string | null {
  if (!isUsable(profile) || profile.pacing.medianMs <= 0) return null;
  const lengthMs = Math.max(0, endMs - startMs);
  const { p25Ms, p75Ms, medianMs } = profile.pacing;
  if (lengthMs >= p25Ms && lengthMs <= p75Ms) {
    return `length matches your usual ${secs(medianMs)}s for this kind of video`;
  }
  if (lengthMs < p25Ms) return `shorter than your usual ${secs(medianMs)}s`;
  return `longer than your usual ${secs(medianMs)}s`;
}

/** How much to nudge a suggestion's score toward the learned length. */
export function lengthAffinity(
  profile: StyleProfile | null | undefined,
  startMs: number,
  endMs: number,
): number {
  if (!isUsable(profile) || profile.pacing.medianMs <= 0) return 0.5;
  const lengthMs = Math.max(1, endMs - startMs);
  const { medianMs } = profile.pacing;
  // Ratio-based so being 10s off matters more on a 20s target than a 120s one.
  const ratio = lengthMs > medianMs ? medianMs / lengthMs : lengthMs / medianMs;
  return Math.max(0, Math.min(1, ratio));
}
