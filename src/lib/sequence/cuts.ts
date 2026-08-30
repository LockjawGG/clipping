/**
 * Removing words from the middle of a clip.
 *
 * Trimming has always worked from the ends: drag the start later, drag the end
 * earlier. This is the other kind of edit — striking a word out of the middle
 * so the clip closes up around it and gets shorter. It is what you want for
 * filler words and false starts, and it is a different operation from
 * censoring, which covers a word over and leaves the length alone.
 *
 * The whole thing is expressed as a transform on a compose plan, which is why
 * it needs almost no machinery of its own: a plan with the struck stretches
 * missing is just a plan with more pieces, and the renderer already knows how
 * to cut a list of pieces and join them. Captions, censor spans and the
 * transcript follow for free, because they were already routed through the
 * plan's source-to-output mapping.
 */

import { mapSourceToTimeline, type ComposePiece } from "./compose.ts";

/** A stretch of one source to leave out of the render. */
export interface CutSpan {
  sourceVideoId: string;
  startMs: number;
  endMs: number;
}

/**
 * The shortest surviving fragment worth keeping.
 *
 * Two words struck a few frames apart would otherwise leave a sliver between
 * them that is too short to be heard as anything but a click, and short enough
 * that some encoders emit no frame for it at all. Anything under this is
 * dropped along with the cuts around it.
 */
export const MIN_KEEP_MS = 120;

/**
 * How far a cut may reach into the silence beside the word it removes.
 *
 * Cutting a word at exactly its own boundaries leaves the pause that preceded
 * it and the pause that followed it, back to back — the hole is audible even
 * though the word is gone. Taking half of each neighbouring gap leaves roughly
 * one ordinary word gap at the seam. The cap only bites on a silence longer
 * than half a second — an ordinary gap between words takes the half rule, and a
 * deliberate pause gets its seam trimmed instead of being eaten.
 */
export const SEAM_PAD_MS = 250;

interface IdentifiedWord {
  id?: string;
  startMs: number;
  endMs: number;
}

/**
 * Turn struck word ids into stretches of source to remove.
 *
 * Neighbours are the immediately adjacent words, struck or not, so a run of
 * struck words closes up completely: each takes half of the gap between them,
 * and the halves meet. The spans returned never reach into a word that was
 * kept — the reach is bounded by the neighbour's own boundary — so this can
 * only ever remove silence, never speech.
 */
export function cutSpansForWords(
  words: readonly IdentifiedWord[],
  removedWordIds: readonly string[],
  sourceVideoId: string,
): CutSpan[] {
  const removed = new Set(removedWordIds);
  if (removed.size === 0) return [];
  const ordered = [...words].sort((a, b) => a.startMs - b.startMs);
  const spans: CutSpan[] = [];

  for (const [i, word] of ordered.entries()) {
    if (!word.id || !removed.has(word.id)) continue;
    let startMs = word.startMs;
    let endMs = word.endMs;

    const prev = ordered[i - 1];
    if (prev && prev.endMs <= word.startMs) {
      startMs -= Math.min(SEAM_PAD_MS, (word.startMs - prev.endMs) / 2);
    }
    const next = ordered[i + 1];
    if (next && next.startMs >= word.endMs) {
      endMs += Math.min(SEAM_PAD_MS, (next.startMs - word.endMs) / 2);
    }

    if (endMs > startMs) {
      spans.push({ sourceVideoId, startMs: Math.round(startMs), endMs: Math.round(endMs) });
    }
  }
  return mergeSpans(spans);
}

/** Overlapping or touching spans of the same source, combined. */
export function mergeSpans(spans: readonly CutSpan[]): CutSpan[] {
  const out: CutSpan[] = [];
  const sorted = [...spans].sort(
    (a, b) => a.sourceVideoId.localeCompare(b.sourceVideoId) || a.startMs - b.startMs,
  );
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last && last.sourceVideoId === span.sourceVideoId && span.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, span.endMs);
    } else {
      out.push({ ...span });
    }
  }
  return out;
}

/**
 * The same plan with the struck stretches missing.
 *
 * Each piece is split around whatever cuts fall inside it and the survivors are
 * repacked end to end, so the output is exactly as much shorter as was removed.
 * Pieces of a source with no cuts pass through untouched.
 *
 * Repacking assumes the pieces given are one packed lane, which is what the
 * base track is. Upper lanes are positioned against the base rather than
 * packed, so they are moved with `remapAcrossCuts` instead of run through here.
 */
export function applyInteriorCuts(
  plan: readonly ComposePiece[],
  spans: readonly CutSpan[],
): ComposePiece[] {
  if (spans.length === 0) return plan.map((p) => ({ ...p }));
  const merged = mergeSpans(spans);
  const out: ComposePiece[] = [];
  let cursor = 0;

  for (const piece of plan) {
    // Where the piece survives, in its own source time. Start with all of it
    // and take the cuts out one at a time.
    let keeps: Array<{ startMs: number; endMs: number }> = [
      { startMs: piece.sourceIn, endMs: piece.sourceOut },
    ];
    for (const span of merged) {
      if (span.sourceVideoId !== piece.sourceVideoId) continue;
      const next: typeof keeps = [];
      for (const keep of keeps) {
        if (span.endMs <= keep.startMs || span.startMs >= keep.endMs) {
          next.push(keep);
          continue;
        }
        if (span.startMs > keep.startMs) next.push({ startMs: keep.startMs, endMs: span.startMs });
        if (span.endMs < keep.endMs) next.push({ startMs: span.endMs, endMs: keep.endMs });
      }
      keeps = next;
    }

    for (const keep of keeps) {
      const durationMs = keep.endMs - keep.startMs;
      // A fragment too short to be heard as anything but a click goes with the
      // cut that isolated it.
      if (durationMs < MIN_KEEP_MS) continue;
      out.push({
        sourceVideoId: piece.sourceVideoId,
        sourceStorageKey: piece.sourceStorageKey,
        sourceIn: keep.startMs,
        sourceOut: keep.endMs,
        timelineStart: cursor,
        durationMs,
      });
      cursor += durationMs;
    }
  }
  return out;
}

/**
 * Follow a position in the output across the cuts.
 *
 * Anything positioned against the old timeline — an overlay window, a piece on
 * a lane above the base — has to move back by however much was removed before
 * it, or it drifts onto the wrong moment. A position inside a removed stretch
 * lands on the seam, which is where its content now begins.
 */
export function remapAcrossCuts(
  before: readonly ComposePiece[],
  after: readonly ComposePiece[],
  timelineMs: number,
): number {
  for (const piece of before) {
    if (timelineMs < piece.timelineStart || timelineMs > piece.timelineStart + piece.durationMs) {
      continue;
    }
    const sourceMs = piece.sourceIn + (timelineMs - piece.timelineStart);
    const mapped = mapSourceToTimeline(after, piece.sourceVideoId, sourceMs);
    if (mapped !== null) return mapped;
    // The moment itself was cut. The next surviving piece of that source is
    // what plays there now, so that is where the seam is.
    const nextPiece = after.find(
      (p) => p.sourceVideoId === piece.sourceVideoId && p.sourceIn >= sourceMs,
    );
    if (nextPiece) return nextPiece.timelineStart;
    return after.reduce((end, p) => Math.max(end, p.timelineStart + p.durationMs), 0);
  }
  return timelineMs;
}

/** How much time a set of cuts takes out of a plan. */
export function cutDurationMs(
  plan: readonly ComposePiece[],
  spans: readonly CutSpan[],
): number {
  const total = (pieces: readonly ComposePiece[]) =>
    pieces.reduce((sum, p) => sum + p.durationMs, 0);
  return Math.max(0, total(plan) - total(applyInteriorCuts(plan, spans)));
}
