/**
 * Turning a packed lane into something the renderer can build.
 *
 * The render has always been one cut of one source. A sequence makes it a list
 * of cuts joined end to end, which changes where everything downstream *is*:
 * a word spoken at 8:12 of the source may land at 0:03 of the export, or be
 * trimmed away entirely and land nowhere.
 *
 * So this module owns two things and nothing else: the ordered list of pieces
 * to cut, and the mapping from source time to output time. Keeping the mapping
 * in one place is what stops captions, censor spans and the transcript from
 * each inventing their own version of it.
 */

import { itemDurationMs, laneItems, type LaneItem } from "./lane.ts";

export interface ComposableItem extends LaneItem {
  sourceVideoId: string | null;
  sourceAssetId: string | null;
  sourceStorageKey?: string | null;
}

export interface ComposePiece {
  /** The video this piece is cut from. */
  sourceVideoId: string;
  /** Where that video's bytes live. */
  sourceStorageKey: string | null;
  /** The slice of that source, in its own timeline. */
  sourceIn: number;
  sourceOut: number;
  /** Where the piece starts in the composed output. */
  timelineStart: number;
  durationMs: number;
}

/**
 * The pieces to cut and join, in order.
 *
 * Only video-backed items compose. An item whose source is a library asset is a
 * still or an audio bed: it has no frames to cut from a source timeline, and
 * placing one is already expressed as an overlay, so it is skipped here rather
 * than guessed at.
 */
export function buildComposePlan(
  items: readonly ComposableItem[],
  trackId: string,
): ComposePiece[] {
  const out: ComposePiece[] = [];
  let cursor = 0;
  for (const item of laneItems(items, trackId)) {
    const duration = itemDurationMs(item);
    if (duration <= 0) continue;
    if (!item.sourceVideoId) {
      // Not composable, but it still occupies its lane position — skipping the
      // time as well would silently shift everything after it.
      cursor += duration;
      continue;
    }
    out.push({
      sourceVideoId: item.sourceVideoId,
      sourceStorageKey: item.sourceStorageKey ?? null,
      sourceIn: item.sourceIn,
      sourceOut: item.sourceOut,
      timelineStart: cursor,
      durationMs: duration,
    });
    cursor += duration;
  }
  return out;
}

/** Total output length of a plan, including any gap left by a skipped item. */
export function planDurationMs(plan: readonly ComposePiece[]): number {
  return plan.reduce((end, p) => Math.max(end, p.timelineStart + p.durationMs), 0);
}

/**
 * Is this plan just the clip as it always rendered?
 *
 * One piece covering exactly the clip's window means the timeline was opened
 * and never edited. That must take the original single-cut path — not for
 * speed, but so that opening the panel out of curiosity cannot change the
 * bytes a render produces.
 */
export function isPlainCut(
  plan: readonly ComposePiece[],
  clip: { videoId: string; startMs: number; endMs: number },
): boolean {
  if (plan.length !== 1) return false;
  const [only] = plan;
  return (
    only.sourceVideoId === clip.videoId &&
    only.sourceIn === clip.startMs &&
    only.sourceOut === clip.endMs
  );
}

/**
 * Where a moment of the source lands in the output, or null if it was trimmed
 * out. The first piece that contains it wins, so a range used twice reports its
 * earlier appearance.
 */
export function mapSourceToTimeline(
  plan: readonly ComposePiece[],
  sourceVideoId: string,
  sourceMs: number,
): number | null {
  for (const piece of plan) {
    if (piece.sourceVideoId !== sourceVideoId) continue;
    if (sourceMs >= piece.sourceIn && sourceMs <= piece.sourceOut) {
      return piece.timelineStart + (sourceMs - piece.sourceIn);
    }
  }
  return null;
}

export interface TimedWord {
  id?: string;
  text: string;
  startMs: number;
  endMs: number;
}

/**
 * Rewrite transcript words onto the composed output.
 *
 * Words are returned in the same coordinate space the renderer already expects —
 * source-absolute, to be rebased by the clip's `startMs` downstream — so every
 * consumer (cues, censor spans, the SRT writer) keeps working unchanged. That is
 * why `offsetMs` is added back rather than returning output-relative times.
 *
 * A word straddling a cut is kept only if its start survives, and is clamped to
 * its piece: half a word at a join reads as a caption glitch, and a censor span
 * that ran past the cut would bleep whatever was spliced in after it.
 */
export function remapWordsToTimeline<T extends TimedWord>(
  words: readonly T[],
  plan: readonly ComposePiece[],
  sourceVideoId: string,
  offsetMs: number,
): T[] {
  const out: T[] = [];
  for (const word of words) {
    for (const piece of plan) {
      if (piece.sourceVideoId !== sourceVideoId) continue;
      if (word.startMs < piece.sourceIn || word.startMs >= piece.sourceOut) continue;
      const shift = offsetMs + piece.timelineStart - piece.sourceIn;
      out.push({
        ...word,
        startMs: word.startMs + shift,
        endMs: Math.min(word.endMs, piece.sourceOut) + shift,
      });
      break;
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}
