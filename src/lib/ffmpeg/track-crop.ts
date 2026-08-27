import type { FocalPoint } from "../faces/track.ts";

/**
 * Turns a focal-point track into a pair of ffmpeg `crop` x/y expressions that
 * pan the crop window between keyframes.
 *
 * `in_w` / `in_h` are the crop filter's input size (the cover-scaled frame), so
 * the fraction is resolved at render time; only the target box W/H and the
 * per-keyframe times/fractions are baked in here. Between keyframes the value
 * is `lerp`-ed on `t`; outside the range it holds the nearest keyframe.
 *
 * Commas are left unescaped — `buildTrackedReframeArgs` escapes them for the
 * filtergraph.
 */
export interface CropExprOptions {
  width: number;
  height: number;
}

function coord(dim: "in_w" | "in_h", box: number, fraction: number): string {
  const f = Math.max(0, Math.min(1, fraction)).toFixed(4);
  // Centre the box on the focal point, clamped inside the frame.
  return `clip(${dim}*${f}-${box / 2},0,${dim}-${box})`;
}

function axisExpr(
  track: FocalPoint[],
  pick: (p: FocalPoint) => number,
  dim: "in_w" | "in_h",
  box: number,
): string {
  const values = track.map((p) => coord(dim, box, pick(p)));
  if (values.length === 1) return values[0];

  // Build from the last segment backwards so each `if` wraps the rest.
  let expr = values[values.length - 1];
  for (let i = track.length - 2; i >= 0; i--) {
    const t0 = (track[i].atMs / 1000).toFixed(3);
    const t1 = (track[i + 1].atMs / 1000).toFixed(3);
    const seg = `lerp(${values[i]},${values[i + 1]},clip((t-${t0})/(${t1}-${t0}),0,1))`;
    expr = `if(lt(t,${t1}),${seg},${expr})`;
  }
  return expr;
}

export function focalTrackToCropExpr(
  track: FocalPoint[],
  { width, height }: CropExprOptions,
): { x: string; y: string } {
  if (track.length === 0) {
    return {
      x: coord("in_w", width, 0.5),
      y: coord("in_h", height, 0.5),
    };
  }
  const sorted = [...track].sort((a, b) => a.atMs - b.atMs);
  return {
    x: axisExpr(sorted, (p) => p.x, "in_w", width),
    y: axisExpr(sorted, (p) => p.y, "in_h", height),
  };
}
