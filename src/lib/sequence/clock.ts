/**
 * The two clocks a clip is measured by.
 *
 * Cutting words out gives a clip two timelines. One is the window it was
 * authored against — where an overlay says it appears, what "set start" means,
 * what the timeline panel's pieces are laid out in. The other is what actually
 * plays: the same clip with the struck stretches missing, which is what the
 * preview scrubs through and what the export contains.
 *
 * Both are milliseconds. Both are `number`. With nothing cut they are equal, so
 * mixing them up is invisible until someone strikes a word — and then every
 * position after the cut is wrong by exactly its length. That mistake has been
 * made, separately, by the captions, the bleeps, the narration, the overlays,
 * the transcript's seek and the censor review.
 *
 * So they are given different types. They are still plain numbers at runtime —
 * this costs nothing and changes no behaviour — but a `PreviewMs` can no longer
 * be passed where a `ClipMs` belongs, and the only way across is the pair of
 * converters the editor builds from the clip's plan. A value that needs no
 * conversion (a focus keyframe, which the render applies after the cut) says so
 * by its type instead of by a comment nobody reads.
 */

declare const clipClock: unique symbol;
declare const previewClock: unique symbol;

/** Milliseconds from the start of the clip's own window, ignoring cuts. */
export type ClipMs = number & { readonly [clipClock]: true };

/** Milliseconds into what plays: the clip with the struck stretches removed. */
export type PreviewMs = number & { readonly [previewClock]: true };

/**
 * Label a raw number as clip time.
 *
 * Every use is a claim about which clock a number came off, so they are worth
 * reading: the right ones sit at the edges, where a time arrives from the
 * server or from a control the user typed into.
 */
export const clipMs = (ms: number): ClipMs => ms as ClipMs;

/** Label a raw number as preview time. See {@link clipMs}. */
export const previewMs = (ms: number): PreviewMs => ms as PreviewMs;

/**
 * Clamp a preview position into the preview's own length.
 *
 * It exists so call sites do not have to re-label after the arithmetic. A
 * `previewMs(...)` wrapped round a `Math.min` is a cast, and a cast will
 * happily launder a clip time into a preview one — which is the mistake this
 * whole module is here to stop. Taking `PreviewMs` in and giving `PreviewMs`
 * out keeps the claim where it can be checked.
 */
export const clampPreview = (ms: PreviewMs, lengthMs: PreviewMs): PreviewMs =>
  previewMs(Math.min(Math.max(0, ms), Math.max(0, lengthMs - 1)));

/** Step a preview position by some milliseconds, staying inside the preview. */
export const stepPreview = (from: PreviewMs, deltaMs: number, lengthMs: PreviewMs): PreviewMs =>
  clampPreview(previewMs(from + deltaMs), lengthMs);
