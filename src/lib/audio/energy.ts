/**
 * Scoring over `AudioFeatures`. Pure, and scored *relative to the clip itself*
 * rather than against absolute thresholds.
 *
 * That relativity is the point: a podcast mastered at -23 LUFS and a phone
 * recording at -8 LUFS have nothing in common on an absolute scale, but "this
 * moment is much louder than the rest of this recording" means the same thing
 * in both. Every score below is a position within the clip's own distribution.
 */

import type { AudioFeatures } from "./features.ts";
import { LUFS_FLOOR } from "./features.ts";

export interface WindowStats {
  /** Mean momentary loudness across the window, in LUFS. */
  meanLufs: number;
  peakLufs: number;
  /** 0..1 position of this window's loudness within the whole clip. */
  energy: number;
  /** Mean spectral flatness. High = broadband (laughter, applause, noise). */
  flatness: number;
  /** Fraction of the window that is detected silence. */
  silenceRatio: number;
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Index range covering [startMs, endMs) in feature windows. */
function range(f: AudioFeatures, startMs: number, endMs: number): [number, number] {
  const step = Math.max(1, f.stepMs);
  const lo = Math.max(0, Math.floor(startMs / step));
  const hi = Math.min(f.loudness.length, Math.max(lo + 1, Math.ceil(endMs / step)));
  return [lo, hi];
}

/** Percentile of the *speech-bearing* windows — silence would drag it down. */
export function loudnessPercentile(f: AudioFeatures, p: number): number {
  const voiced = f.loudness.filter((n) => n > LUFS_FLOOR + 1);
  if (voiced.length === 0) return LUFS_FLOOR;
  const sorted = [...voiced].sort((a, b) => a - b);
  const i = clamp01(p) * (sorted.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * Map a loudness to 0..1 against the clip's own spread, using the 10th and 95th
 * percentiles as the ends. Percentiles rather than min/max because a single
 * clipped frame or one dead moment would otherwise define the whole scale.
 */
export function energyScale(f: AudioFeatures): (lufs: number) => number {
  const lo = loudnessPercentile(f, 0.1);
  const hi = loudnessPercentile(f, 0.95);
  const span = hi - lo;
  if (!Number.isFinite(span) || span < 1) return () => 0.5;
  return (lufs: number) => clamp01((lufs - lo) / span);
}

export function windowStats(f: AudioFeatures, startMs: number, endMs: number): WindowStats {
  const [lo, hi] = range(f, startMs, endMs);
  const scale = energyScale(f);

  let sum = 0;
  let peak = LUFS_FLOOR;
  let flat = 0;
  let n = 0;
  for (let i = lo; i < hi; i++) {
    const l = f.loudness[i] ?? LUFS_FLOOR;
    sum += l;
    if (l > peak) peak = l;
    flat += f.flatness[i] ?? 0;
    n++;
  }
  const meanLufs = n ? sum / n : LUFS_FLOOR;

  let silentMs = 0;
  for (const s of f.silences) {
    const a = Math.max(s.startMs, startMs);
    const b = Math.min(s.endMs, endMs);
    if (b > a) silentMs += b - a;
  }
  const spanMs = Math.max(1, endMs - startMs);

  return {
    meanLufs,
    peakLufs: peak,
    energy: scale(meanLufs),
    flatness: n ? flat / n : 0,
    silenceRatio: clamp01(silentMs / spanMs),
  };
}

export interface AudioMoment {
  startMs: number;
  endMs: number;
  /** 0..1 confidence, from how far the window sits above the clip's norm. */
  score: number;
  kind: "energy" | "laughter";
  /** Human-readable evidence, shown to the user with the suggestion. */
  reason: string;
}

export interface MomentOptions {
  /** Percentile a window must clear to count as high energy. */
  energyPercentile?: number;
  /** Flatness above this is broadband enough to be laughter or applause. */
  flatnessThreshold?: number;
  /** Ignore blips shorter than this. */
  minDurationMs?: number;
  /** Join moments separated by less than this. */
  mergeGapMs?: number;
}

/** Contiguous runs of windows that satisfy `pass`, merged and length-filtered. */
function runs(
  f: AudioFeatures,
  pass: (i: number) => boolean,
  minDurationMs: number,
  mergeGapMs: number,
): Array<[number, number]> {
  const step = Math.max(1, f.stepMs);
  const spans: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i < f.loudness.length; i++) {
    if (pass(i)) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      spans.push([start * step, i * step]);
      start = -1;
    }
  }
  if (start >= 0) spans.push([start * step, f.loudness.length * step]);

  const merged: Array<[number, number]> = [];
  for (const s of spans) {
    const prev = merged[merged.length - 1];
    if (prev && s[0] - prev[1] <= mergeGapMs) prev[1] = s[1];
    else merged.push([s[0], s[1]]);
  }
  return merged.filter(([a, b]) => b - a >= minDurationMs);
}

/**
 * Moments worth a look: sustained high energy, and broadband bursts that read
 * as laughter or applause.
 *
 * These are *candidates for review*, never automatic edits. The reason string
 * travels with each one so the user can see what was measured rather than
 * being handed an unexplained suggestion.
 */
export function findAudioMoments(f: AudioFeatures, opts: MomentOptions = {}): AudioMoment[] {
  if (f.loudness.length === 0) return [];
  const {
    energyPercentile = 0.85,
    flatnessThreshold = 0.35,
    minDurationMs = 600,
    mergeGapMs = 500,
  } = opts;

  const scale = energyScale(f);
  const hot = loudnessPercentile(f, energyPercentile);
  const median = loudnessPercentile(f, 0.5);
  const out: AudioMoment[] = [];

  for (const [a, b] of runs(f, (i) => (f.loudness[i] ?? LUFS_FLOOR) >= hot, minDurationMs, mergeGapMs)) {
    const s = windowStats(f, a, b);
    out.push({
      startMs: a,
      endMs: b,
      score: clamp01(scale(s.meanLufs)),
      kind: "energy",
      reason: `${(s.meanLufs - median).toFixed(1)} LU above this recording's median`,
    });
  }

  // Laughter is broadband *and* loud — broadband alone is just noise or hiss.
  for (const [a, b] of runs(
    f,
    (i) => (f.flatness[i] ?? 0) >= flatnessThreshold && (f.loudness[i] ?? LUFS_FLOOR) >= median,
    minDurationMs,
    mergeGapMs,
  )) {
    const s = windowStats(f, a, b);
    out.push({
      startMs: a,
      endMs: b,
      score: clamp01(s.flatness),
      kind: "laughter",
      reason: `broadband burst (flatness ${s.flatness.toFixed(2)}) at conversational level or above`,
    });
  }

  return out.sort((x, y) => x.startMs - y.startMs);
}

/** Silence long enough to be worth cutting. */
export function findDeadAir(f: AudioFeatures, minMs = 800): SilenceLike[] {
  return f.silences
    .filter((s) => s.endMs - s.startMs >= minMs)
    .map((s) => ({ startMs: s.startMs, endMs: s.endMs, durationMs: s.endMs - s.startMs }));
}

export interface SilenceLike {
  startMs: number;
  endMs: number;
  durationMs: number;
}
