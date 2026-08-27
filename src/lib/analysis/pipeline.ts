import type { ClipSuggestion, Segment } from "../providers/types.ts";
import {
  DEFAULT_SNAP_CONFIG,
  capTotalRuntime,
  dedupeOverlapping,
  snapToSentences,
} from "../clips/boundaries.ts";

/**
 * The step the README calls out: "feed output through snapToSentences ->
 * dedupeOverlapping -> capTotalRuntime before persisting. Never trust raw model
 * timestamps."
 *
 * Every analysis provider returns raw suggestions with approximate boundaries.
 * This is the one place those get turned into clips worth cutting.
 */
export interface RefineOptions {
  minClipMs: number;
  maxClipMs: number;
  maxClips: number;
  /** Total clipped runtime as a fraction of the source. */
  maxTotalRatio?: number;
  padStartMs?: number;
  padEndMs?: number;
}

export function refineSuggestions(
  raw: ClipSuggestion[],
  segments: Segment[],
  videoDurationMs: number,
  options: RefineOptions,
): ClipSuggestion[] {
  if (raw.length === 0 || segments.length === 0) return [];

  const snapConfig = {
    minClipMs: options.minClipMs,
    maxClipMs: options.maxClipMs,
    padStartMs: options.padStartMs ?? DEFAULT_SNAP_CONFIG.padStartMs,
    padEndMs: options.padEndMs ?? DEFAULT_SNAP_CONFIG.padEndMs,
  };

  // 1. Snap each suggestion to enclosing sentence boundaries; drop the ones
  //    that can't be made to fit the length limits.
  const snapped: ClipSuggestion[] = [];
  for (const clip of raw) {
    const result = snapToSentences(
      { startMs: clip.startMs, endMs: clip.endMs },
      segments,
      videoDurationMs,
      snapConfig,
    );
    if (result.rejectedReason) continue;
    snapped.push({ ...clip, startMs: result.startMs, endMs: result.endMs });
  }
  if (snapped.length === 0) return [];

  // 2. Drop overlaps, keeping the higher-scoring clip. 3. Cap total runtime.
  const deduped = dedupeOverlapping(snapped);
  let capped = capTotalRuntime(deduped, videoDurationMs, options.maxTotalRatio ?? 0.2);

  // The cap is a budget, not a gate: a single strong clip that spans most of a
  // short video can blow the budget on its own — still return the best one
  // rather than nothing.
  if (capped.length === 0 && deduped.length > 0) {
    capped = [[...deduped].sort((a, b) => b.score - a.score)[0]];
  }

  // 4. Keep the best `maxClips`, then return in timeline order.
  return [...capped]
    .sort((a, b) => b.score - a.score)
    .slice(0, options.maxClips)
    .sort((a, b) => a.startMs - b.startMs);
}
