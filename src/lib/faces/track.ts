/**
 * Focal-point track processing.
 *
 * A face detector emits raw `{ atMs, x, y }` samples (x/y normalised 0..1 in
 * the source frame). Before that can drive a crop it needs cleaning up:
 * clamp to frame, sort, drop jitter, and resample to an even cadence so the
 * crop animation is smooth rather than snapping between detections.
 */
export interface FocalPoint {
  atMs: number;
  x: number;
  y: number;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function clampPoint(p: FocalPoint): FocalPoint {
  return { atMs: Math.max(0, Math.round(p.atMs)), x: clamp01(p.x), y: clamp01(p.y) };
}

/** Exponential moving average over a time-sorted track. `alpha` in (0,1]. */
export function smoothTrack(track: FocalPoint[], alpha = 0.35): FocalPoint[] {
  const points = track.map(clampPoint).sort((a, b) => a.atMs - b.atMs);
  if (points.length <= 1) return points;

  const out: FocalPoint[] = [{ ...points[0] }];
  let x = points[0].x;
  let y = points[0].y;
  for (let i = 1; i < points.length; i++) {
    x = alpha * points[i].x + (1 - alpha) * x;
    y = alpha * points[i].y + (1 - alpha) * y;
    out.push({ atMs: points[i].atMs, x, y });
  }
  return out;
}

/** Linear-interpolate the focal point at an arbitrary time. */
export function sampleFocalAt(track: FocalPoint[], atMs: number): FocalPoint {
  if (track.length === 0) return { atMs, x: 0.5, y: 0.5 };
  if (atMs <= track[0].atMs) return { ...track[0], atMs };
  const last = track[track.length - 1];
  if (atMs >= last.atMs) return { ...last, atMs };

  for (let i = 1; i < track.length; i++) {
    const a = track[i - 1];
    const b = track[i];
    if (atMs <= b.atMs) {
      const t = b.atMs === a.atMs ? 0 : (atMs - a.atMs) / (b.atMs - a.atMs);
      return { atMs, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
  }
  return { ...last, atMs };
}

/**
 * Resample a track to one point every `stepMs`, spanning `[0, durationMs]`.
 * Keeps the crop keyframe count bounded regardless of detection density.
 */
export function resampleTrack(track: FocalPoint[], durationMs: number, stepMs = 500): FocalPoint[] {
  const smoothed = smoothTrack(track);
  if (smoothed.length === 0) return [];
  const out: FocalPoint[] = [];
  for (let ms = 0; ms <= durationMs; ms += stepMs) {
    out.push(sampleFocalAt(smoothed, ms));
  }
  return out;
}
