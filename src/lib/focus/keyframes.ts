/**
 * The timed capture window: a user-authored, keyframed crop that pans and
 * zooms over the clip.
 *
 * This is the manual sibling of the face tracker. Both end up as the same
 * `FocalPoint[]` the render path already consumes (`focalTrackToCropExpr`),
 * so the only genuinely new thing here is zoom — a focal point says *where* to
 * look, a capture window also says *how close*.
 *
 * Precedence in the renderer, widest to narrowest:
 *   1. a keyframed capture window (this module)  — the user placed it
 *   2. `Clip.focalX/focalY`                      — one static point
 *   3. the detected face track                   — automatic fallback
 *
 * Easing comes from the caption animation vocabulary rather than a second
 * private copy, so "ease out" means the same curve everywhere in the product.
 */

import type { AnimEase } from "../captions/anim-spec.ts";
import { EASINGS, springProgress } from "../captions/anim-eval.ts";
import type { FocalPoint } from "../faces/track.ts";

/** One authored capture-window keyframe. */
export interface FocusKeyframe {
  /** ms from the start of the clip. */
  atMs: number;
  /** Normalised 0..1 centre of the window, in the cover-scaled frame. */
  x: number;
  y: number;
  /** 1 = the full target box; 2 = twice as close. */
  scale: number;
  /** Easing used on the way *into* this keyframe. Default `inOut`. */
  ease?: AnimEase;
}

/** A sampled window: where to look and how close. */
export interface FocusSample {
  x: number;
  y: number;
  scale: number;
}

export const FOCUS_LIMITS = {
  /** Below 1 the window would be larger than the frame and letterbox. */
  scale: { min: 1, max: 4, step: 0.05, default: 1 },
} as const;

const EASE_IDS = new Set<string>(["linear", "in", "out", "inOut", "spring"]);

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

const clamp01 = (n: number) => clamp(n, 0, 1);

function easeValue(p: number, ease: AnimEase): number {
  const t = clamp01(p);
  if (ease === "spring") return springProgress(t);
  return EASINGS[ease](t);
}

/**
 * Parse a stored capture window. Anything malformed yields an empty track
 * rather than throwing — a corrupt blob must not fail a render, it must fall
 * through to the next strategy in the precedence list above.
 */
export function parseFocusTrack(json: string | null | undefined): FocusKeyframe[] {
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  // Accept both a bare array and `{ keyframes: [...] }` so the column can grow
  // per-window options later without a migration.
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { keyframes?: unknown }).keyframes)
      ? ((raw as { keyframes: unknown[] }).keyframes as unknown[])
      : [];

  const out: FocusKeyframe[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const k = item as Record<string, unknown>;
    const atMs = k.atMs;
    const x = k.x;
    const y = k.y;
    if (typeof atMs !== "number" || !Number.isFinite(atMs)) continue;
    if (typeof x !== "number" || !Number.isFinite(x)) continue;
    if (typeof y !== "number" || !Number.isFinite(y)) continue;
    const scale =
      typeof k.scale === "number" && Number.isFinite(k.scale)
        ? clamp(k.scale, FOCUS_LIMITS.scale.min, FOCUS_LIMITS.scale.max)
        : FOCUS_LIMITS.scale.default;
    const kf: FocusKeyframe = {
      atMs: Math.max(0, Math.round(atMs)),
      x: clamp01(x),
      y: clamp01(y),
      scale,
    };
    if (typeof k.ease === "string" && EASE_IDS.has(k.ease)) kf.ease = k.ease as AnimEase;
    out.push(kf);
  }
  // Sampling scans in order, so sort once here rather than on every frame.
  out.sort((a, b) => a.atMs - b.atMs);
  return out;
}

/** Serialise, dropping an empty track so an untouched clip stores null. */
export function serializeFocusTrack(keyframes: FocusKeyframe[]): string | null {
  const clean = parseFocusTrack(JSON.stringify(keyframes));
  return clean.length ? JSON.stringify(clean) : null;
}

/**
 * The window at an arbitrary time. Holds the first keyframe before the track
 * starts and the last one after it ends, so a single keyframe is a valid
 * static reframe rather than an error.
 */
export function sampleFocusAt(keyframes: readonly FocusKeyframe[], atMs: number): FocusSample {
  if (keyframes.length === 0) return { x: 0.5, y: 0.5, scale: 1 };
  const first = keyframes[0];
  if (atMs <= first.atMs) return { x: first.x, y: first.y, scale: first.scale };
  const last = keyframes[keyframes.length - 1];
  if (atMs >= last.atMs) return { x: last.x, y: last.y, scale: last.scale };

  for (let i = 1; i < keyframes.length; i++) {
    const b = keyframes[i];
    if (atMs > b.atMs) continue;
    const a = keyframes[i - 1];
    const span = b.atMs - a.atMs;
    // Two keyframes at the same instant is a hard cut, not a divide by zero.
    const p = span <= 0 ? 1 : easeValue((atMs - a.atMs) / span, b.ease ?? "inOut");
    return {
      x: a.x + (b.x - a.x) * p,
      y: a.y + (b.y - a.y) * p,
      scale: a.scale + (b.scale - a.scale) * p,
    };
  }
  return { x: last.x, y: last.y, scale: last.scale };
}

/** True when the window ever zooms, so the render needs `zoompan` rather than
 *  the cheaper fixed-box `crop`. */
export function focusNeedsZoom(keyframes: readonly FocusKeyframe[]): boolean {
  return keyframes.some((k) => k.scale > 1.0001);
}

/**
 * Flatten an authored window to the dense, evenly-spaced `FocalPoint[]` the
 * existing crop-expression builder consumes. Easing is baked into the samples,
 * which is why the step is fine-grained: the expression itself only lerps.
 *
 * Position-only windows can therefore reuse the proven `crop` path untouched.
 */
export function focusToFocalTrack(
  keyframes: readonly FocusKeyframe[],
  durationMs: number,
  stepMs = 250,
): FocalPoint[] {
  if (keyframes.length === 0) return [];
  const out: FocalPoint[] = [];
  const step = Math.max(16, stepMs);
  for (let ms = 0; ms <= durationMs; ms += step) {
    const s = sampleFocusAt(keyframes, ms);
    out.push({ atMs: ms, x: s.x, y: s.y });
  }
  // Always pin the exact end so the last keyframe is honoured rather than
  // truncated by the step.
  const endSample = sampleFocusAt(keyframes, durationMs);
  if (out.length === 0 || out[out.length - 1].atMs !== durationMs) {
    out.push({ atMs: Math.max(0, durationMs), x: endSample.x, y: endSample.y });
  }
  return out;
}

/** The same flattening, keeping the zoom, for the `zoompan` path. */
export function focusToSamples(
  keyframes: readonly FocusKeyframe[],
  durationMs: number,
  stepMs = 250,
): (FocusSample & { atMs: number })[] {
  if (keyframes.length === 0) return [];
  const out: (FocusSample & { atMs: number })[] = [];
  const step = Math.max(16, stepMs);
  for (let ms = 0; ms <= durationMs; ms += step) {
    out.push({ atMs: ms, ...sampleFocusAt(keyframes, ms) });
  }
  if (out.length === 0 || out[out.length - 1].atMs !== durationMs) {
    out.push({ atMs: Math.max(0, durationMs), ...sampleFocusAt(keyframes, durationMs) });
  }
  return out;
}
