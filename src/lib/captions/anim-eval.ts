/**
 * Pure evaluator for the declarative text-animation spec (`anim-spec.ts`).
 *
 * Framework-free: give it a set of tracks, an elapsed time and a unit index, get
 * back a resolved transform. The editor's DOM interpreter uses this directly;
 * the Remotion renderer uses it for the non-spring tracks and defers to
 * Remotion's own `spring()` for spring tracks so the burn matches frame-for-frame.
 */

import type { AnimEase, AnimTrack, SpringConfig } from "./anim-spec.ts";
import { DEFAULT_SPRING } from "./anim-spec.ts";

type Named = Exclude<AnimEase, "spring">;

export const EASINGS: Record<Named, (p: number) => number> = {
  linear: (p) => p,
  in: (p) => p * p,
  out: (p) => 1 - (1 - p) * (1 - p),
  inOut: (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2),
};

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * A closed-form spring curve normalised so the visible motion spans `p` in
 * [0, 1] and settles near 1. Underdamped configs overshoot slightly (that is
 * the point of a spring); critically/overdamped configs fall back to ease-out.
 *
 * This is the *preview* approximation. The final render calls Remotion's real
 * `spring()` with the same `SpringConfig`, so any small curve difference here
 * never reaches an exported video.
 */
export function springProgress(p: number, cfg: SpringConfig = DEFAULT_SPRING): number {
  const t = clamp01(p);
  const { damping, stiffness, mass = 1 } = cfg;
  const omega0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  if (!isFinite(zeta) || zeta >= 1) return EASINGS.out(t);
  const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);
  // Scale time so ~3 decay constants elapse across p in [0,1] -> lands near 1.
  const tau = (3 / (zeta * omega0)) * t;
  const envelope = Math.exp(-zeta * omega0 * tau);
  return 1 - envelope * Math.cos(omegaD * tau);
}

/** Eased 0..1 progress for a track at a given elapsed time and unit index. */
export function trackProgress(track: AnimTrack, elapsedMs: number, unitIndex = 0): number {
  const stagger = track.stagger ? track.stagger.stepMs * Math.max(0, unitIndex) : 0;
  const local = elapsedMs - (track.startMs ?? 0) - stagger;
  const dur = track.durMs ?? 200;
  const raw = dur <= 0 ? (local >= 0 ? 1 : 0) : local / dur;
  const p = clamp01(raw);
  if ((track.ease ?? "out") === "spring") return springProgress(p, track.spring);
  return EASINGS[(track.ease ?? "out") as Named](p);
}

/** The interpolated value of a single track (from -> to by eased progress). */
export function sampleTrack(track: AnimTrack, elapsedMs: number, unitIndex = 0): number {
  const eased = trackProgress(track, elapsedMs, unitIndex);
  return track.from + (track.to - track.from) * eased;
}

export interface ResolvedTransform {
  opacity: number;
  translateX: number;
  translateY: number;
  scale: number;
  rotate: number;
  blur: number;
}

export const IDENTITY_TRANSFORM: ResolvedTransform = {
  opacity: 1,
  translateX: 0,
  translateY: 0,
  scale: 1,
  rotate: 0,
  blur: 0,
};

/**
 * Fold a set of tracks into one transform. Translations / rotation / blur add;
 * scale multiplies; opacity is taken from the last opacity track (there is only
 * ever one in the builtin presets).
 */
export function sampleTracks(
  tracks: readonly AnimTrack[],
  elapsedMs: number,
  unitIndex = 0,
): ResolvedTransform {
  const out: ResolvedTransform = { ...IDENTITY_TRANSFORM };
  for (const track of tracks) {
    const v = sampleTrack(track, elapsedMs, unitIndex);
    switch (track.prop) {
      case "opacity":
        out.opacity = v;
        break;
      case "translateX":
        out.translateX += v;
        break;
      case "translateY":
        out.translateY += v;
        break;
      case "scale":
        out.scale *= v;
        break;
      case "rotate":
        out.rotate += v;
        break;
      case "blur":
        out.blur += v;
        break;
    }
  }
  return out;
}

/** A resolved transform as inline CSS. */
export function transformCss(t: ResolvedTransform): {
  transform: string;
  opacity: number;
  filter?: string;
} {
  const parts: string[] = [];
  if (t.translateX !== 0 || t.translateY !== 0) {
    parts.push(`translate(${round(t.translateX)}px, ${round(t.translateY)}px)`);
  }
  if (t.scale !== 1) parts.push(`scale(${round(t.scale, 4)})`);
  if (t.rotate !== 0) parts.push(`rotate(${round(t.rotate, 3)}deg)`);
  return {
    transform: parts.length ? parts.join(" ") : "none",
    opacity: round(t.opacity, 4),
    ...(t.blur > 0 ? { filter: `blur(${round(t.blur, 3)}px)` } : {}),
  };
}

function round(n: number, dp = 2): number {
  const k = 10 ** dp;
  return Math.round(n * k) / k;
}
