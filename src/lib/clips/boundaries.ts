import type { Segment } from "../providers/types.ts";

/**
 * Snaps model-proposed clip windows onto sentence boundaries.
 *
 * An LLM reading a transcript returns approximate times. Cutting on those
 * directly is the single most common reason a clip opens on half a word. We
 * snap outward to the enclosing sentences, then enforce length limits by
 * trimming whole sentences rather than slicing mid-sentence.
 */

export interface SnapConfig {
  minClipMs: number;
  maxClipMs: number;
  /** Lead-in before the first word, so the clip doesn't open on a plosive. */
  padStartMs: number;
  /** Tail after the last word, so the final syllable isn't clipped. */
  padEndMs: number;
}

export const DEFAULT_SNAP_CONFIG: SnapConfig = {
  minClipMs: 20_000,
  maxClipMs: 60_000,
  padStartMs: 250,
  padEndMs: 400,
};

export interface SnapInput {
  startMs: number;
  endMs: number;
}

export interface SnapResult {
  startMs: number;
  endMs: number;
  /** Segment indices the clip covers, for the transcript editor. */
  segmentIndices: number[];
  /** Set when the window couldn't be made to satisfy the length limits. */
  rejectedReason?: string;
}

export function snapToSentences(
  input: SnapInput,
  segments: Segment[],
  videoDurationMs: number,
  config: SnapConfig = DEFAULT_SNAP_CONFIG,
): SnapResult {
  if (segments.length === 0) {
    return { ...input, segmentIndices: [], rejectedReason: "no transcript segments" };
  }

  // A segment is included when it overlaps the requested window at all, so a
  // window landing mid-sentence expands outward to contain it.
  const covered: number[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.endMs > input.startMs && seg.startMs < input.endMs) covered.push(i);
  }

  // Window fell entirely in a silence between segments: attach the nearest one.
  if (covered.length === 0) {
    let nearest = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < segments.length; i++) {
      const distance = Math.min(
        Math.abs(segments[i].startMs - input.startMs),
        Math.abs(segments[i].endMs - input.endMs),
      );
      if (distance < best) {
        best = distance;
        nearest = i;
      }
    }
    covered.push(nearest);
  }

  let first = covered[0];
  let last = covered[covered.length - 1];

  const span = () => segments[last].endMs - segments[first].startMs;

  // Too long: drop whole sentences from whichever end is further from the
  // requested window, so we bias toward keeping what the model actually chose.
  while (span() > config.maxClipMs && last > first) {
    const dropFromStart = segments[first].startMs < input.startMs;
    const dropFromEnd = segments[last].endMs > input.endMs;
    if (dropFromStart && !dropFromEnd) first++;
    else if (dropFromEnd && !dropFromStart) last--;
    else if (input.startMs - segments[first].startMs > segments[last].endMs - input.endMs) first++;
    else last--;
  }

  // Too short: grow by whole sentences, preferring the side with more room.
  while (span() < config.minClipMs && (first > 0 || last < segments.length - 1)) {
    const canGrowStart = first > 0;
    const canGrowEnd = last < segments.length - 1;
    if (canGrowEnd && !canGrowStart) last++;
    else if (canGrowStart && !canGrowEnd) first--;
    else {
      const startGain = segments[first].startMs - segments[first - 1].startMs;
      const endGain = segments[last + 1].endMs - segments[last].endMs;
      if (endGain <= startGain) last++;
      else first--;
    }
    if (span() > config.maxClipMs) break;
  }

  const startMs = Math.max(0, segments[first].startMs - config.padStartMs);
  const endMs = Math.min(videoDurationMs, segments[last].endMs + config.padEndMs);
  const duration = endMs - startMs;

  const indices: number[] = [];
  for (let i = first; i <= last; i++) indices.push(i);

  const result: SnapResult = { startMs, endMs, segmentIndices: indices };

  if (duration < config.minClipMs) {
    result.rejectedReason = `clip is ${Math.round(duration / 1000)}s, below the ${Math.round(config.minClipMs / 1000)}s minimum`;
  } else if (duration > config.maxClipMs) {
    result.rejectedReason = `clip is ${Math.round(duration / 1000)}s, above the ${Math.round(config.maxClipMs / 1000)}s maximum`;
  }

  return result;
}

/** Drops overlaps, keeping the higher-scoring clip. Input order is irrelevant. */
export function dedupeOverlapping<T extends { startMs: number; endMs: number; score: number }>(
  clips: T[],
  maxOverlapRatio = 0.25,
): T[] {
  const sorted = [...clips].sort((a, b) => b.score - a.score);
  const kept: T[] = [];

  for (const clip of sorted) {
    const conflicts = kept.some((k) => {
      const overlap = Math.min(k.endMs, clip.endMs) - Math.max(k.startMs, clip.startMs);
      if (overlap <= 0) return false;
      const shorter = Math.min(k.endMs - k.startMs, clip.endMs - clip.startMs);
      return overlap / shorter > maxOverlapRatio;
    });
    if (!conflicts) kept.push(clip);
  }

  return kept.sort((a, b) => a.startMs - b.startMs);
}

/** Caps total clipped runtime as a share of the source. */
export function capTotalRuntime<T extends { startMs: number; endMs: number; score: number }>(
  clips: T[],
  videoDurationMs: number,
  maxRatio = 0.2,
): T[] {
  const budget = videoDurationMs * maxRatio;
  const byScore = [...clips].sort((a, b) => b.score - a.score);
  const kept: T[] = [];
  let used = 0;

  for (const clip of byScore) {
    const duration = clip.endMs - clip.startMs;
    if (used + duration > budget) continue;
    kept.push(clip);
    used += duration;
  }

  return kept.sort((a, b) => a.startMs - b.startMs);
}
