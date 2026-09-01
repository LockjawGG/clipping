/**
 * Turning a stretch of stored history back into a stream.
 *
 * Replay reuses the live render path exactly — the same events, pushed into the
 * same reducer, just on a timer instead of a socket. That is the whole point of
 * doing the scheduling as one pure function here: there is no second rendering
 * code path that could drift from the live one, and the awkward part (relative
 * timing) is testable without a clock.
 */

import type { TelemetryEventRow } from "./types.ts";

export interface ReplayStep {
  event: TelemetryEventRow;
  /** Milliseconds after playback starts at which this event should be emitted. */
  atMs: number;
}

export interface ReplayOptions {
  /** 1 = real time, 8 = eight times faster. Values <= 0 are treated as 1. */
  speed?: number;
  /**
   * Longest real gap between consecutive events, before scaling. Recorded
   * history is mostly silence — a four-hour window can hold three minutes of
   * activity and 3h57m of nothing, which replays as a frozen screen. Gaps
   * longer than this are compressed to it. Set to `Infinity` for true
   * wall-clock fidelity.
   */
  maxGapMs?: number;
}

const DEFAULT_MAX_GAP_MS = 4_000;

/**
 * Schedule events for playback, oldest first, offsets relative to the first.
 *
 * Rows are sorted by timestamp before scheduling (history arrives newest-first
 * from the API), and out-of-order or identical timestamps collapse to a zero
 * gap rather than a negative one, so `atMs` is always non-decreasing.
 */
export function buildReplaySchedule(
  events: readonly TelemetryEventRow[],
  options: ReplayOptions = {},
): ReplayStep[] {
  if (events.length === 0) return [];
  const speed = options.speed && options.speed > 0 ? options.speed : 1;
  const maxGap = options.maxGapMs ?? DEFAULT_MAX_GAP_MS;

  const ordered = [...events].sort((a, b) => (a.ts === b.ts ? 0 : a.ts < b.ts ? -1 : 1));

  const steps: ReplayStep[] = [];
  let elapsed = 0;
  let previous = Date.parse(ordered[0].ts);
  for (const event of ordered) {
    const at = Date.parse(event.ts);
    // An unparseable timestamp contributes no gap rather than a NaN that would
    // poison every offset after it.
    const gap = Number.isFinite(at) && Number.isFinite(previous) ? at - previous : 0;
    elapsed += Math.min(Math.max(gap, 0), maxGap);
    if (Number.isFinite(at)) previous = at;
    steps.push({ event, atMs: Math.round(elapsed / speed) });
  }
  return steps;
}

/** Total playback length of a schedule, in milliseconds. */
export function replayDurationMs(steps: readonly ReplayStep[]): number {
  return steps.length === 0 ? 0 : steps[steps.length - 1].atMs;
}
