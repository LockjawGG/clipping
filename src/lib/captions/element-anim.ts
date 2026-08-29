/**
 * Intro / outro animations for freestanding text elements (Text & Captions
 * phase 3e). Reuses the declarative `AnimTrack` shape and the pure evaluator
 * from the caption animation system, so the editor preview and the Remotion
 * render read the same presets.
 *
 * An element's `animationJson` is `{ intro?: id, outro?: id }`. Intro tracks
 * play forward from the element's start; outro tracks play in the final window
 * before its end. Outside those windows the element sits at identity.
 */

import type { AnimTrack } from "./anim-spec.ts";
import { sampleTracks, transformCss, type ResolvedTransform } from "./anim-eval.ts";

export interface ElementAnimation {
  id: string;
  label: string;
}

export const ELEMENT_INTROS: Record<string, AnimTrack[]> = {
  none: [],
  fade: [{ prop: "opacity", from: 0, to: 1, durMs: 250, ease: "out" }],
  "slide-up": [
    { prop: "translateY", from: 26, to: 0, ease: "spring", spring: { damping: 18, stiffness: 180 } },
    { prop: "opacity", from: 0, to: 1, durMs: 200, ease: "out" },
  ],
  "slide-down": [
    { prop: "translateY", from: -26, to: 0, ease: "spring", spring: { damping: 18, stiffness: 180 } },
    { prop: "opacity", from: 0, to: 1, durMs: 200, ease: "out" },
  ],
  "slide-left": [
    { prop: "translateX", from: 34, to: 0, ease: "spring", spring: { damping: 18, stiffness: 180 } },
    { prop: "opacity", from: 0, to: 1, durMs: 200, ease: "out" },
  ],
  "slide-right": [
    { prop: "translateX", from: -34, to: 0, ease: "spring", spring: { damping: 18, stiffness: 180 } },
    { prop: "opacity", from: 0, to: 1, durMs: 200, ease: "out" },
  ],
  pop: [
    { prop: "scale", from: 0.6, to: 1, ease: "spring", spring: { damping: 12, stiffness: 220 } },
    { prop: "opacity", from: 0, to: 1, durMs: 150, ease: "out" },
  ],
  "zoom-in": [
    { prop: "scale", from: 1.4, to: 1, durMs: 300, ease: "out" },
    { prop: "opacity", from: 0, to: 1, durMs: 200, ease: "out" },
  ],
  "blur-in": [
    { prop: "blur", from: 12, to: 0, durMs: 300, ease: "out" },
    { prop: "opacity", from: 0, to: 1, durMs: 250, ease: "out" },
  ],
};

export const ELEMENT_OUTROS: Record<string, AnimTrack[]> = {
  none: [],
  fade: [{ prop: "opacity", from: 1, to: 0, durMs: 250, ease: "in" }],
  "slide-down": [
    { prop: "translateY", from: 0, to: 26, durMs: 250, ease: "in" },
    { prop: "opacity", from: 1, to: 0, durMs: 250, ease: "in" },
  ],
  "slide-up": [
    { prop: "translateY", from: 0, to: -26, durMs: 250, ease: "in" },
    { prop: "opacity", from: 1, to: 0, durMs: 250, ease: "in" },
  ],
  "pop-out": [
    { prop: "scale", from: 1, to: 0.6, durMs: 200, ease: "in" },
    { prop: "opacity", from: 1, to: 0, durMs: 200, ease: "in" },
  ],
  "zoom-out": [
    { prop: "scale", from: 1, to: 1.4, durMs: 300, ease: "in" },
    { prop: "opacity", from: 1, to: 0, durMs: 250, ease: "in" },
  ],
  "blur-out": [
    { prop: "blur", from: 0, to: 12, durMs: 300, ease: "in" },
    { prop: "opacity", from: 1, to: 0, durMs: 250, ease: "in" },
  ],
};

export const ELEMENT_INTRO_OPTIONS: ElementAnimation[] = Object.keys(ELEMENT_INTROS).map((id) => ({
  id,
  label: id === "none" ? "None" : id.replace(/-/g, " "),
}));
export const ELEMENT_OUTRO_OPTIONS: ElementAnimation[] = Object.keys(ELEMENT_OUTROS).map((id) => ({
  id,
  label: id === "none" ? "None" : id.replace(/-/g, " "),
}));

export interface ElementAnimSpec {
  intro?: string;
  outro?: string;
}

export function parseElementAnim(json: string | null | undefined): ElementAnimSpec {
  if (!json) return {};
  try {
    const p = JSON.parse(json);
    if (p && typeof p === "object" && !Array.isArray(p)) {
      const out: ElementAnimSpec = {};
      if (typeof p.intro === "string") out.intro = p.intro;
      if (typeof p.outro === "string") out.outro = p.outro;
      return out;
    }
  } catch {
    /* ignore */
  }
  return {};
}

/** Serialise, dropping "none" / empty so a static element stays null. */
export function serializeElementAnim(spec: ElementAnimSpec): string | null {
  const out: ElementAnimSpec = {};
  if (spec.intro && spec.intro !== "none" && ELEMENT_INTROS[spec.intro]) out.intro = spec.intro;
  if (spec.outro && spec.outro !== "none" && ELEMENT_OUTROS[spec.outro]) out.outro = spec.outro;
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

/** ms from the phase anchor after which a track set has fully settled. */
function animWindow(tracks: readonly AnimTrack[]): number {
  let max = 0;
  for (const t of tracks) max = Math.max(max, (t.startMs ?? 0) + (t.durMs ?? 200));
  return max;
}

function combine(a: ResolvedTransform, b: ResolvedTransform): ResolvedTransform {
  return {
    opacity: a.opacity * b.opacity,
    translateX: a.translateX + b.translateX,
    translateY: a.translateY + b.translateY,
    scale: a.scale * b.scale,
    rotate: a.rotate + b.rotate,
    blur: a.blur + b.blur,
  };
}

export interface ElementAnimContext {
  /** ms since the element became visible (>= 0). */
  elapsedMs: number;
  /** ms until the element disappears; null when it runs to the clip end. */
  remainingMs: number | null;
}

/**
 * The element's transform at a point in time: intro tracks near the start,
 * outro tracks near the end, identity in between.
 */
export function sampleElementAnim(
  spec: ElementAnimSpec,
  ctx: ElementAnimContext,
): { transform: string; opacity: number; filter?: string } {
  const intro = spec.intro ? ELEMENT_INTROS[spec.intro] ?? [] : [];
  const outro = spec.outro ? ELEMENT_OUTROS[spec.outro] ?? [] : [];

  let t = sampleTracks(intro, Math.max(0, ctx.elapsedMs));

  if (outro.length && ctx.remainingMs !== null) {
    const win = animWindow(outro);
    if (ctx.remainingMs < win) {
      t = combine(t, sampleTracks(outro, win - ctx.remainingMs));
    }
  }

  return transformCss(t);
}
