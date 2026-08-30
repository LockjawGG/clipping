/**
 * Lane packing: what "the same layer" means on the timeline.
 *
 * Items on one track are laid end to end — no gaps, no overlaps. Dropping media
 * into a lane therefore lengthens the timeline by that media's duration, and
 * trimming a piece pulls everything after it back to close the hole. That is the
 * whole point: you can trim without then having to drag every later piece into
 * place by hand.
 *
 * `timelineStart` is consequently *derived*, never authored. The client may send
 * one to say where a piece was dropped, but it is read as "put it here in the
 * order" and the real positions are recomputed from the durations. Storing a
 * position the layout does not agree with is how timelines drift.
 */

export interface LaneItem {
  id: string;
  trackId: string;
  /** Left-to-right position within its track. */
  order: number;
  sourceIn: number;
  sourceOut: number;
}

/** How long one piece occupies the timeline. */
export const itemDurationMs = (item: Pick<LaneItem, "sourceIn" | "sourceOut">): number =>
  Math.max(0, item.sourceOut - item.sourceIn);

/** Items of one track, left to right. `order` decides, id breaks ties so the
 *  result is stable across calls rather than depending on query order. */
export function laneItems<T extends LaneItem>(items: readonly T[], trackId: string): T[] {
  return items
    .filter((i) => i.trackId === trackId)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/**
 * The `timelineStart` every item should have, by id.
 *
 * Every track is packed independently from zero: lanes run in parallel, pieces
 * within a lane run in sequence.
 */
export function packLanes<T extends LaneItem>(items: readonly T[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const trackId of new Set(items.map((i) => i.trackId))) {
    let cursor = 0;
    for (const item of laneItems(items, trackId)) {
      out.set(item.id, cursor);
      cursor += itemDurationMs(item);
    }
  }
  return out;
}

/** Total length of one lane. */
export function laneDurationMs<T extends LaneItem>(items: readonly T[], trackId: string): number {
  return laneItems(items, trackId).reduce((sum, i) => sum + itemDurationMs(i), 0);
}

/** The sequence's length: the longest lane, since lanes play together. */
export function sequenceDurationMs<T extends LaneItem>(items: readonly T[]): number {
  let longest = 0;
  for (const trackId of new Set(items.map((i) => i.trackId))) {
    longest = Math.max(longest, laneDurationMs(items, trackId));
  }
  return longest;
}

/**
 * The order values for a lane after a piece is dropped at `dropMs`.
 *
 * A drag reports a pixel position, which only ever means "before or after this
 * neighbour" once lanes are packed — so the position is resolved to an index
 * here and the caller renumbers. Ties land *after* the piece already there,
 * which is what dropping onto a boundary looks like from the user's side.
 */
export function insertionIndex<T extends LaneItem>(
  items: readonly T[],
  trackId: string,
  dropMs: number,
  excludeId?: string,
): number {
  const lane = laneItems(items, trackId).filter((i) => i.id !== excludeId);
  let cursor = 0;
  for (let i = 0; i < lane.length; i++) {
    const mid = cursor + itemDurationMs(lane[i]) / 2;
    if (dropMs < mid) return i;
    cursor += itemDurationMs(lane[i]);
  }
  return lane.length;
}
