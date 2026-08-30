/**
 * Motion for freestanding elements — text, images, GIFs (Text & Captions phase
 * 3e, extended by the motion system).
 *
 * Reuses the declarative `AnimTrack` shape and the pure evaluator from the
 * caption animation system, so the editor preview and the Remotion render read
 * the same presets and cannot drift.
 *
 * An element's `animationJson` is an `ElementAnimSpec`: preset ids for
 * `intro` / `loop` / `outro`, optional inspector overrides (intensity, timing,
 * easing), and optional user `keyframes` layered on top. Intro tracks play
 * forward from the element's start; outro tracks play in the final window
 * before its end; the loop runs continuously in between.
 *
 * Everything here is pure and allocation-light: `sampleElementAnim` is called
 * once per element per frame inside the Remotion render loop.
 */

import type { AnimEase, AnimTrack } from "./anim-spec.ts";
import {
  EASINGS,
  IDENTITY_TRANSFORM,
  sampleTracks,
  springProgress,
  transformCss,
  type ResolvedTransform,
} from "./anim-eval.ts";

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
  // Loose spring so the element overshoots and settles — the "drop in" feel.
  "bounce-in": [
    { prop: "translateY", from: -46, to: 0, ease: "spring", spring: { damping: 5, stiffness: 190 } },
    { prop: "opacity", from: 0, to: 1, durMs: 160, ease: "out" },
  ],
  "rotate-in": [
    { prop: "rotate", from: -14, to: 0, ease: "spring", spring: { damping: 14, stiffness: 200 } },
    { prop: "scale", from: 0.82, to: 1, ease: "spring", spring: { damping: 14, stiffness: 200 } },
    { prop: "opacity", from: 0, to: 1, durMs: 220, ease: "out" },
  ],
  // A full turn, unlike rotate-in's tilt.
  "spin-in": [
    { prop: "rotate", from: -360, to: 0, durMs: 520, ease: "out" },
    { prop: "scale", from: 0.4, to: 1, durMs: 520, ease: "out" },
    { prop: "opacity", from: 0, to: 1, durMs: 240, ease: "out" },
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
  // Dips before it leaves, mirroring bounce-in's overshoot.
  "bounce-out": [
    { prop: "translateY", from: 0, to: 52, durMs: 320, ease: "in" },
    { prop: "opacity", from: 1, to: 0, durMs: 260, ease: "in" },
  ],
  "rotate-out": [
    { prop: "rotate", from: 0, to: 14, durMs: 280, ease: "in" },
    { prop: "scale", from: 1, to: 0.82, durMs: 280, ease: "in" },
    { prop: "opacity", from: 1, to: 0, durMs: 260, ease: "in" },
  ],
  "spin-out": [
    { prop: "rotate", from: 0, to: 360, durMs: 520, ease: "in" },
    { prop: "scale", from: 1, to: 0.4, durMs: 520, ease: "in" },
    { prop: "opacity", from: 1, to: 0, durMs: 400, ease: "in" },
  ],
};

/**
 * A continuous while-on-screen motion.
 *
 * `sine` (the default) oscillates the property around its rest value forever.
 * `ramp` moves once from rest to `amp` across `periodMs` and then holds — a
 * Ken Burns style slow zoom is a ramp, not an oscillation.
 */
export interface LoopTrack {
  prop: "translateX" | "translateY" | "scale" | "rotate" | "opacity";
  amp: number;
  periodMs: number;
  /** radians, so tracks can run out of phase. Ignored by `ramp`. */
  phase?: number;
  mode?: "sine" | "ramp";
}

export const ELEMENT_LOOPS: Record<string, LoopTrack[]> = {
  none: [],
  float: [{ prop: "translateY", amp: 6, periodMs: 2600 }],
  pulse: [{ prop: "scale", amp: 0.03, periodMs: 1600 }],
  wiggle: [{ prop: "rotate", amp: 2, periodMs: 1400 }],
  breathe: [{ prop: "opacity", amp: 0.12, periodMs: 3200 }],
  sway: [
    { prop: "translateX", amp: 5, periodMs: 3000 },
    { prop: "rotate", amp: 1.2, periodMs: 3000, phase: Math.PI / 2 },
  ],
  // Mismatched periods so the path never retraces itself — reads as wandering
  // rather than a repeating loop.
  drift: [
    { prop: "translateX", amp: 9, periodMs: 7000 },
    { prop: "translateY", amp: 6, periodMs: 5200, phase: Math.PI / 3 },
  ],
  // Equal periods a quarter-turn apart trace a circle.
  orbit: [
    { prop: "translateX", amp: 8, periodMs: 4200 },
    { prop: "translateY", amp: 8, periodMs: 4200, phase: Math.PI / 2 },
  ],
  pan: [{ prop: "translateX", amp: 16, periodMs: 8000 }],
  shake: [
    { prop: "translateX", amp: 2.6, periodMs: 170 },
    { prop: "translateY", amp: 1.4, periodMs: 230, phase: Math.PI / 4 },
  ],
  bobbing: [
    { prop: "translateY", amp: 9, periodMs: 1800 },
    { prop: "rotate", amp: 1, periodMs: 3600, phase: Math.PI / 2 },
  ],
  "slow-zoom": [{ prop: "scale", amp: 0.14, periodMs: 12000, mode: "ramp" }],
};

const label = (id: string) => (id === "none" ? "None" : id.replace(/-/g, " "));

export const ELEMENT_INTRO_OPTIONS: ElementAnimation[] = Object.keys(ELEMENT_INTROS).map((id) => ({
  id,
  label: label(id),
}));
export const ELEMENT_OUTRO_OPTIONS: ElementAnimation[] = Object.keys(ELEMENT_OUTROS).map((id) => ({
  id,
  label: label(id),
}));
export const ELEMENT_LOOP_OPTIONS: ElementAnimation[] = Object.keys(ELEMENT_LOOPS).map((id) => ({
  id,
  label: label(id),
}));

// ---------- inspector overrides ----------

/** Bounds every override is clamped to, shared with the inspector sliders. */
export const MOTION_LIMITS = {
  intensity: { min: 0, max: 4, step: 0.05, default: 1 },
  speed: { min: 0.1, max: 6, step: 0.1, default: 1 },
  durationMs: { min: 0, max: 10000, step: 10 },
  delayMs: { min: 0, max: 10000, step: 10 },
} as const;

export const MOTION_EASES: { id: AnimEase; label: string }[] = [
  { id: "out", label: "Ease out" },
  { id: "in", label: "Ease in" },
  { id: "inOut", label: "Ease in-out" },
  { id: "linear", label: "Linear" },
  { id: "spring", label: "Spring" },
];

/**
 * One user-authored motion keyframe. Every field but `atMs` is optional; a
 * property is interpolated only across the keyframes that actually set it, so
 * a scale-only keyframe never snaps position back to the origin.
 */
export interface MotionKeyframe {
  /** ms since the element appeared. */
  atMs: number;
  /** px offsets. */
  x?: number;
  y?: number;
  scale?: number;
  /** degrees. */
  rotate?: number;
  opacity?: number;
  /** Easing used on the way *into* this keyframe. Default `inOut`. */
  ease?: AnimEase;
}

export interface ElementAnimSpec {
  intro?: string;
  outro?: string;
  loop?: string;
  /** Multiplies the magnitude of every non-opacity track. 1 = preset default. */
  intensity?: number;
  /** Override the intro / outro tween length in ms. */
  introMs?: number;
  outroMs?: number;
  /** Hold the element at its intro start for this long before playing. */
  delayMs?: number;
  /** Loop rate multiplier; 2 = twice as fast. */
  loopSpeed?: number;
  /** Force an easing on intro + outro tracks, replacing the preset's. */
  ease?: AnimEase;
  /** Sorted ascending by `atMs`. Layered on top of the presets. */
  keyframes?: MotionKeyframe[];
}

const KF_PROPS = ["x", "y", "scale", "rotate", "opacity"] as const;
type KfProp = (typeof KF_PROPS)[number];

const EASE_IDS = new Set<string>(["linear", "in", "out", "inOut", "spring"]);

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/** A finite number within bounds, or undefined. */
function num(v: unknown, lo: number, hi: number): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? clamp(v, lo, hi) : undefined;
}

function parseKeyframes(raw: unknown): MotionKeyframe[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: MotionKeyframe[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const k = item as Record<string, unknown>;
    const atMs = num(k.atMs, 0, 3600000);
    if (atMs === undefined) continue;
    const kf: MotionKeyframe = { atMs };
    const x = num(k.x, -20000, 20000);
    const y = num(k.y, -20000, 20000);
    const scale = num(k.scale, 0, 100);
    const rotate = num(k.rotate, -36000, 36000);
    const opacity = num(k.opacity, 0, 1);
    if (x !== undefined) kf.x = x;
    if (y !== undefined) kf.y = y;
    if (scale !== undefined) kf.scale = scale;
    if (rotate !== undefined) kf.rotate = rotate;
    if (opacity !== undefined) kf.opacity = opacity;
    if (typeof k.ease === "string" && EASE_IDS.has(k.ease)) kf.ease = k.ease as AnimEase;
    // A keyframe that sets no property carries no information.
    if (Object.keys(kf).length > 1) out.push(kf);
  }
  if (!out.length) return undefined;
  // Sampling assumes ascending order so it can scan without sorting per frame.
  out.sort((a, b) => a.atMs - b.atMs);
  return out;
}

export function parseElementAnim(json: string | null | undefined): ElementAnimSpec {
  if (!json) return {};
  try {
    const p = JSON.parse(json);
    if (p && typeof p === "object" && !Array.isArray(p)) {
      const out: ElementAnimSpec = {};
      if (typeof p.intro === "string") out.intro = p.intro;
      if (typeof p.outro === "string") out.outro = p.outro;
      if (typeof p.loop === "string") out.loop = p.loop;

      const L = MOTION_LIMITS;
      const intensity = num(p.intensity, L.intensity.min, L.intensity.max);
      const loopSpeed = num(p.loopSpeed, L.speed.min, L.speed.max);
      const introMs = num(p.introMs, L.durationMs.min, L.durationMs.max);
      const outroMs = num(p.outroMs, L.durationMs.min, L.durationMs.max);
      const delayMs = num(p.delayMs, L.delayMs.min, L.delayMs.max);
      if (intensity !== undefined) out.intensity = intensity;
      if (loopSpeed !== undefined) out.loopSpeed = loopSpeed;
      if (introMs !== undefined) out.introMs = introMs;
      if (outroMs !== undefined) out.outroMs = outroMs;
      if (delayMs !== undefined) out.delayMs = delayMs;
      if (typeof p.ease === "string" && EASE_IDS.has(p.ease)) out.ease = p.ease as AnimEase;

      const keyframes = parseKeyframes(p.keyframes);
      if (keyframes) out.keyframes = keyframes;
      return out;
    }
  } catch {
    /* ignore */
  }
  return {};
}

/** Serialise, dropping "none" / defaults / empty so a static element stays null. */
export function serializeElementAnim(spec: ElementAnimSpec): string | null {
  const out: Record<string, unknown> = {};
  if (spec.intro && spec.intro !== "none" && ELEMENT_INTROS[spec.intro]) out.intro = spec.intro;
  if (spec.outro && spec.outro !== "none" && ELEMENT_OUTROS[spec.outro]) out.outro = spec.outro;
  if (spec.loop && spec.loop !== "none" && ELEMENT_LOOPS[spec.loop]) out.loop = spec.loop;

  const L = MOTION_LIMITS;
  const intensity = num(spec.intensity, L.intensity.min, L.intensity.max);
  const loopSpeed = num(spec.loopSpeed, L.speed.min, L.speed.max);
  const introMs = num(spec.introMs, L.durationMs.min, L.durationMs.max);
  const outroMs = num(spec.outroMs, L.durationMs.min, L.durationMs.max);
  const delayMs = num(spec.delayMs, L.delayMs.min, L.delayMs.max);
  if (intensity !== undefined && intensity !== 1) out.intensity = intensity;
  if (loopSpeed !== undefined && loopSpeed !== 1) out.loopSpeed = loopSpeed;
  if (introMs !== undefined) out.introMs = introMs;
  if (outroMs !== undefined) out.outroMs = outroMs;
  if (delayMs !== undefined && delayMs !== 0) out.delayMs = delayMs;
  if (spec.ease && EASE_IDS.has(spec.ease)) out.ease = spec.ease;

  const keyframes = parseKeyframes(spec.keyframes);
  if (keyframes) out.keyframes = keyframes;

  return Object.keys(out).length ? JSON.stringify(out) : null;
}

// ---------- evaluation ----------

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

interface TuneOptions {
  intensity?: number;
  durMs?: number;
  delayMs?: number;
  ease?: AnimEase;
}

/**
 * Apply inspector overrides to a preset's tracks, returning fresh objects — the
 * preset arrays are module-level constants and must never be mutated.
 *
 * Intensity scales a track's *travel* (`from` relative to `to`) rather than its
 * raw values, so a scale track from 0.6 to 1 grows outward instead of collapsing
 * toward zero. Opacity is exempt: fading in from 40% is not "less intense", it
 * is a different animation.
 */
function tuneTracks(tracks: readonly AnimTrack[], opts: TuneOptions): readonly AnimTrack[] {
  const intensity = opts.intensity ?? 1;
  const hasIntensity = intensity !== 1;
  if (!hasIntensity && opts.durMs === undefined && !opts.delayMs && !opts.ease) return tracks;

  return tracks.map((t) => {
    const out: AnimTrack = { ...t };
    if (hasIntensity && t.prop !== "opacity") out.from = t.to + (t.from - t.to) * intensity;
    if (opts.durMs !== undefined) out.durMs = opts.durMs;
    if (opts.delayMs) out.startMs = (t.startMs ?? 0) + opts.delayMs;
    if (opts.ease) {
      out.ease = opts.ease;
      if (opts.ease !== "spring") delete out.spring;
    }
    return out;
  });
}

function tuneLoop(
  tracks: readonly LoopTrack[],
  intensity: number,
  speed: number,
): readonly LoopTrack[] {
  if (intensity === 1 && speed === 1) return tracks;
  return tracks.map((t) => ({
    ...t,
    amp: t.amp * intensity,
    periodMs: Math.max(16, t.periodMs / speed),
  }));
}

/** Periodic (or ramping) loop transform at time `tMs` since the element appeared. */
function sampleLoop(tracks: readonly LoopTrack[], tMs: number): ResolvedTransform {
  const out: ResolvedTransform = { ...IDENTITY_TRANSFORM };
  for (const t of tracks) {
    const v =
      t.mode === "ramp"
        ? t.amp * clamp(tMs / t.periodMs, 0, 1)
        : t.amp * Math.sin((2 * Math.PI * tMs) / t.periodMs + (t.phase ?? 0));
    switch (t.prop) {
      case "translateX":
        out.translateX += v;
        break;
      case "translateY":
        out.translateY += v;
        break;
      case "rotate":
        out.rotate += v;
        break;
      case "scale":
        out.scale *= 1 + v;
        break;
      case "opacity":
        out.opacity *= Math.min(1, 1 + v);
        break;
    }
  }
  return out;
}

function easeValue(p: number, ease: AnimEase): number {
  const t = clamp(p, 0, 1);
  if (ease === "spring") return springProgress(t);
  return EASINGS[ease](t);
}

/**
 * The value of one keyframed property at `tMs`, or null when no keyframe sets
 * it. Assumes `kfs` is sorted ascending (guaranteed by `parseElementAnim`) so
 * this is a single allocation-free scan — it runs per element per frame.
 */
function sampleKfProp(kfs: readonly MotionKeyframe[], prop: KfProp, tMs: number): number | null {
  let aV = 0;
  let aAt = 0;
  let haveA = false;
  let bV = 0;
  let bAt = 0;
  let bEase: AnimEase = "inOut";
  let haveB = false;

  for (const k of kfs) {
    const v = k[prop];
    if (typeof v !== "number") continue;
    if (k.atMs <= tMs) {
      aV = v;
      aAt = k.atMs;
      haveA = true;
    } else if (!haveB) {
      bV = v;
      bAt = k.atMs;
      bEase = k.ease ?? "inOut";
      haveB = true;
    }
  }

  if (!haveA && !haveB) return null;
  if (!haveA) return bV; // before the first keyframe — hold it
  if (!haveB) return aV; // after the last one — hold it
  const span = bAt - aAt;
  if (span <= 0) return bV;
  return aV + (bV - aV) * easeValue((tMs - aAt) / span, bEase);
}

function sampleKeyframes(kfs: readonly MotionKeyframe[], tMs: number): ResolvedTransform {
  const out: ResolvedTransform = { ...IDENTITY_TRANSFORM };
  for (const prop of KF_PROPS) {
    const v = sampleKfProp(kfs, prop, tMs);
    if (v === null) continue;
    switch (prop) {
      case "x":
        out.translateX += v;
        break;
      case "y":
        out.translateY += v;
        break;
      case "scale":
        out.scale *= v;
        break;
      case "rotate":
        out.rotate += v;
        break;
      case "opacity":
        out.opacity *= v;
        break;
    }
  }
  return out;
}

export interface ElementAnimContext {
  /** ms since the element became visible (>= 0). */
  elapsedMs: number;
  /** ms until the element disappears; null when it runs to the clip end. */
  remainingMs: number | null;
}

/**
 * The element's transform at a point in time: intro tracks near the start,
 * outro tracks near the end, the loop throughout, and user keyframes layered on
 * top. Translations and rotation add; scale and opacity multiply — so a loop
 * and a keyframe compose rather than one clobbering the other.
 */
export function sampleElementAnim(
  spec: ElementAnimSpec,
  ctx: ElementAnimContext,
): { transform: string; opacity: number; filter?: string } {
  const introPreset = spec.intro ? ELEMENT_INTROS[spec.intro] ?? [] : [];
  const outroPreset = spec.outro ? ELEMENT_OUTROS[spec.outro] ?? [] : [];
  const loopPreset = spec.loop ? ELEMENT_LOOPS[spec.loop] ?? [] : [];

  const intensity = spec.intensity ?? 1;
  const elapsed = Math.max(0, ctx.elapsedMs);

  const intro = tuneTracks(introPreset, {
    intensity,
    durMs: spec.introMs,
    delayMs: spec.delayMs,
    ease: spec.ease,
  });

  let t = sampleTracks(intro, elapsed);

  if (loopPreset.length) {
    const loop = tuneLoop(loopPreset, intensity, spec.loopSpeed ?? 1);
    // The loop waits out the intro delay so the two do not fight on entry.
    t = combine(t, sampleLoop(loop, Math.max(0, elapsed - (spec.delayMs ?? 0))));
  }

  if (outroPreset.length && ctx.remainingMs !== null) {
    // The outro is anchored to the element's end, so the intro delay never
    // shifts it — only an explicit outroMs changes its length.
    const outro = tuneTracks(outroPreset, {
      intensity,
      durMs: spec.outroMs,
      ease: spec.ease,
    });
    const win = animWindow(outro);
    if (ctx.remainingMs < win) t = combine(t, sampleTracks(outro, win - ctx.remainingMs));
  }

  if (spec.keyframes && spec.keyframes.length) {
    t = combine(t, sampleKeyframes(spec.keyframes, elapsed));
  }

  return transformCss(t);
}
