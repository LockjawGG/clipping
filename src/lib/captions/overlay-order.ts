/**
 * Cross-kind overlay z-ordering, shared by the Remotion render path
 * (`remotion/CaptionedClip.tsx`) and the in-browser preview
 * (`clip-player.tsx`), so the two can never disagree about what paints on
 * top of what.
 *
 * Overlays live in one table ordered by `zIndex`, but the render props (and
 * the preview's own state) used to carry text and image overlays as two
 * separate arrays. Rendering them as two stacked blocks — all text, then all
 * images — throws away any interleaving between kinds: a text overlay with
 * zIndex 5 could never sit under an image overlay with zIndex 6 unless every
 * text overlay was also below every image overlay. `orderOverlayLayers`
 * (and the comparator it wraps) is the one place both render paths sort by
 * `zIndex`, so a fix here can't drift between the burned output and what the
 * user sees while editing.
 */

export interface ZOrdered {
  zIndex: number;
  /**
   * Tiebreak key for equal `zIndex`. We use the overlay's own row id rather
   * than array/object insertion order or `createdAt`: insertion order is an
   * accident of how the data arrived (DB row order, object key order, a
   * client-side optimistic-update array) and isn't guaranteed stable across
   * a re-fetch, while `createdAt` can collide at millisecond resolution for
   * overlays added in the same request and isn't loaded by every query path.
   * `id` is always present, unique, and immutable, so sorting by it makes
   * the order of equal-zIndex overlays deterministic and independent of
   * where the array came from.
   */
  id: string;
}

/** Ascending by `zIndex` (lower renders first / underneath), then by `id`. */
export function compareZOrder(a: ZOrdered, b: ZOrdered): number {
  if (a.zIndex !== b.zIndex) return a.zIndex - b.zIndex;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** Returns a new array sorted bottom-to-top by `zIndex`, tiebroken by `id`. */
export function orderOverlayLayers<T extends ZOrdered>(items: readonly T[]): T[] {
  return [...items].sort(compareZOrder);
}
