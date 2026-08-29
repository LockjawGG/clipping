/**
 * Declarative text-animation spec.
 *
 * Phase 1 of the Text & Captions system. Instead of hand-coding each caption
 * animation as a branch in the Remotion renderer, an animation is *data*: a set
 * of tracks, each moving one CSS-expressible property from one value to another
 * over a time window, with an easing and an optional per-unit stagger.
 *
 * Two interpreters read this exact shape:
 *   - the DOM interpreter (`anim-eval.ts` -> editor preview), and
 *   - the Remotion interpreter (`remotion/CaptionedClip.tsx` -> final burn).
 *
 * Because both read the same document, the preview cannot drift from the render,
 * and "add an animation" becomes "add a JSON preset" rather than a code change.
 *
 * This module has ZERO imports on purpose so it is safe to pull into the
 * Remotion bundle.
 */

export type AnimProp = "opacity" | "translateX" | "translateY" | "scale" | "rotate" | "blur";
export type AnimEase = "linear" | "in" | "out" | "inOut" | "spring";

/** Whether a clause animates each word, or the cue as a whole. */
export type AnimScope = "word" | "cue";

/** `intro` fires from the unit's start; `active` holds while the word is spoken;
 *  `outro` fires as it leaves. Phase 1 only uses `intro` and `active`. */
export type AnimPhase = "intro" | "active" | "outro";

export interface SpringConfig {
  damping: number;
  stiffness: number;
  mass?: number;
}

export interface AnimTrack {
  prop: AnimProp;
  from: number;
  to: number;
  /** ms offset from the phase anchor (word.startMs or cue.startMs). Negative
   *  values pre-roll the motion (e.g. fade a word in before it is spoken). */
  startMs?: number;
  /** Tween length in ms. `0` is an instant step. Default 200. */
  durMs?: number;
  /** Default `"out"`. `"spring"` also consults `spring`. */
  ease?: AnimEase;
  spring?: SpringConfig;
  /** Per-unit delay: `stepMs * unitIndex` added to `startMs`. */
  stagger?: { unit: "letter" | "word" | "line"; stepMs: number };
}

export interface AnimClause {
  scope: AnimScope;
  phase: AnimPhase;
  tracks: AnimTrack[];
}

/** How word text appears: all at once, one word at a time, or char-by-char. */
export type RevealMode = "none" | "word" | "char";

/** `active` = only the current word is lit; `progressive` = every spoken word
 *  stays lit (karaoke). */
export type HighlightMode = "active" | "progressive";

export interface TextAnimation {
  id: string;
  label: string;
  clauses: AnimClause[];
  reveal: RevealMode;
  highlight: HighlightMode;
}

export const DEFAULT_SPRING: SpringConfig = { damping: 12, stiffness: 200, mass: 1 };

/**
 * The nine shipping caption animations, re-expressed as data. Keyed by the
 * string the Remotion composition already uses (`remotionPreset()` output), so
 * this is a drop-in source of truth — the visuals are unchanged.
 */
export const BUILTIN_TEXT_ANIMATIONS: Record<string, TextAnimation> = {
  none: {
    id: "none",
    label: "None",
    reveal: "none",
    highlight: "active",
    clauses: [],
  },
  "word-by-word": {
    id: "word-by-word",
    label: "Word by word",
    reveal: "word",
    highlight: "active",
    clauses: [],
  },
  fade: {
    id: "fade",
    label: "Fade in",
    reveal: "none",
    highlight: "active",
    clauses: [
      {
        scope: "word",
        phase: "intro",
        tracks: [{ prop: "opacity", from: 0, to: 1, startMs: -120, durMs: 120, ease: "linear" }],
      },
    ],
  },
  pop: {
    id: "pop",
    label: "Pop",
    reveal: "none",
    highlight: "active",
    clauses: [
      {
        scope: "word",
        phase: "intro",
        tracks: [
          { prop: "scale", from: 1.16, to: 1, ease: "spring", spring: { damping: 12, stiffness: 200 } },
        ],
      },
    ],
  },
  scale: {
    id: "scale",
    label: "Scale up",
    reveal: "none",
    highlight: "active",
    clauses: [
      {
        scope: "word",
        phase: "active",
        tracks: [{ prop: "scale", from: 1.06, to: 1.06, durMs: 0, ease: "linear" }],
      },
    ],
  },
  bounce: {
    id: "bounce",
    label: "Bounce",
    reveal: "none",
    highlight: "active",
    clauses: [
      {
        scope: "word",
        phase: "intro",
        tracks: [
          { prop: "translateY", from: -18, to: 0, ease: "spring", spring: { damping: 6, stiffness: 180 } },
        ],
      },
    ],
  },
  karaoke: {
    id: "karaoke",
    label: "Karaoke",
    reveal: "none",
    highlight: "progressive",
    clauses: [],
  },
  "slide-up": {
    id: "slide-up",
    label: "Slide up",
    reveal: "none",
    highlight: "active",
    clauses: [
      {
        scope: "cue",
        phase: "intro",
        tracks: [
          { prop: "translateY", from: 28, to: 0, ease: "spring", spring: { damping: 20, stiffness: 160 } },
          { prop: "opacity", from: 0, to: 1, ease: "spring", spring: { damping: 20, stiffness: 160 } },
        ],
      },
    ],
  },
  typewriter: {
    id: "typewriter",
    label: "Typewriter",
    reveal: "char",
    highlight: "active",
    clauses: [],
  },
};

/** Resolve a preset id (Remotion string form) to its animation document. */
export function resolveTextAnimation(id: string | null | undefined): TextAnimation {
  if (id && BUILTIN_TEXT_ANIMATIONS[id]) return BUILTIN_TEXT_ANIMATIONS[id];
  return BUILTIN_TEXT_ANIMATIONS["word-by-word"];
}

/** Clauses for a given scope + phase, flattened to their tracks. */
export function tracksFor(anim: TextAnimation, scope: AnimScope, phase: AnimPhase): AnimTrack[] {
  return anim.clauses.filter((c) => c.scope === scope && c.phase === phase).flatMap((c) => c.tracks);
}

/**
 * Whether an animation id needs the Remotion path rather than the fast ffmpeg
 * burn. The style side of the decision lives in `text-style.ts`
 * (`styleNeedsRemotion` / `captionNeedsRemotion`) so this module stays
 * import-free for the Remotion bundle.
 */
export function needsRemotion(animationId: string | null | undefined): boolean {
  return (
    animationId != null &&
    animationId !== "" &&
    animationId !== "NONE" &&
    animationId !== "none"
  );
}
