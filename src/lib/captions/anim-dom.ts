/**
 * DOM interpreter for the text-animation spec.
 *
 * Turns an animation id + the playhead + a word/cue's timing into the inline
 * CSS (and reveal/highlight decisions) the editor preview needs. Phase 2 wires
 * this into `clip-player.tsx`; Phase 1 ships it tested and ready.
 *
 * The Remotion renderer does the equivalent work against `frame`; both sides
 * read the same `anim-spec.ts` documents, so preview and burn stay in lockstep.
 */

import { resolveTextAnimation, tracksFor } from "./anim-spec.ts";
import { sampleTracks, transformCss, IDENTITY_TRANSFORM } from "./anim-eval.ts";

export interface WordTiming {
  startMs: number;
  endMs: number;
  /** Position of the word within its cue (drives stagger). */
  index: number;
}

export interface CueTiming {
  startMs: number;
  endMs: number;
}

export interface CaptionCss {
  transform: string;
  opacity: number;
  filter?: string;
}

export interface CaptionWordAnim {
  css: CaptionCss;
  /** Whether this word should be drawn in the highlight colour. */
  highlighted: boolean;
  /** The text to render: the whole word, or a leading slice (typewriter). */
  visibleText: string;
  /** True when the word has not been revealed yet (word-by-word before spoken). */
  hidden: boolean;
}

const IDENTITY_CSS: CaptionCss = { transform: "none", opacity: 1 };

/** Per-word animation state at time `tMs` (clip-relative, milliseconds). */
export function captionWordAnim(
  animationId: string | null | undefined,
  tMs: number,
  word: WordTiming,
  text: string,
): CaptionWordAnim {
  const anim = resolveTextAnimation(animationId);
  const spoken = tMs >= word.startMs;
  const active = spoken && tMs < word.endMs;
  const elapsed = tMs - word.startMs;

  // reveal
  let hidden = false;
  let visibleText = text;
  if (anim.reveal === "word") {
    hidden = !spoken;
    if (hidden) visibleText = "";
  } else if (anim.reveal === "char") {
    if (!spoken) {
      visibleText = "";
    } else if (active) {
      const dur = Math.max(1, word.endMs - word.startMs);
      const p = Math.min(1, Math.max(0, elapsed / dur));
      visibleText = text.slice(0, Math.ceil(p * text.length));
    }
  }

  // highlight
  const highlighted = anim.highlight === "progressive" ? spoken : active;

  // transform: intro tracks always apply (they settle); active tracks only hold
  // while the word is being spoken.
  const intro = tracksFor(anim, "word", "intro");
  const activeTracks = active ? tracksFor(anim, "word", "active") : [];
  const tracks = [...intro, ...activeTracks];
  const css = tracks.length ? transformCss(sampleTracks(tracks, elapsed, word.index)) : IDENTITY_CSS;

  return { css, highlighted, visibleText, hidden };
}

/** Whole-cue animation state at time `tMs` (slide-up and friends). */
export function captionCueAnim(
  animationId: string | null | undefined,
  tMs: number,
  cue: CueTiming,
): CaptionCss {
  const anim = resolveTextAnimation(animationId);
  const tracks = tracksFor(anim, "cue", "intro");
  if (!tracks.length) return IDENTITY_CSS;
  return transformCss(sampleTracks(tracks, tMs - cue.startMs, 0));
}

/** Exposed for callers that want the neutral state without a spec lookup. */
export const NEUTRAL_CAPTION_CSS: CaptionCss = IDENTITY_CSS;
export { IDENTITY_TRANSFORM };
