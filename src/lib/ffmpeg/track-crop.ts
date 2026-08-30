import type { FocalPoint } from "../faces/track.ts";
import type { FocusSample } from "../focus/keyframes.ts";

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

// ---------------------------------------------------------------- zoom + pan

/**
 * A capture window that zooms cannot use `crop`: a video stream's frame size is
 * fixed, and `crop`'s w/h are evaluated once at filter configuration, so the
 * window cannot change size over time. `zoompan` exists for exactly this — it
 * crops a shrinking region and scales it back to a constant output size.
 *
 * Its expressions are evaluated per *output* frame, with `on` as the output
 * frame counter, so time is `on/fps` rather than the `t` the crop path uses.
 */
export interface ZoompanOptions {
  width: number;
  height: number;
  fps: number;
}

export interface ZoompanExpr {
  z: string;
  x: string;
  y: string;
}

/**
 * Piecewise-linear interpolation of `values` over `times`, keyed on `on/fps`.
 *
 * Redundant samples are dropped first. The window is sampled densely so easing
 * is resolved in the values rather than the expression, but a long clip would
 * otherwise nest one `if()` per sample per axis — hundreds of them — which is
 * slow to parse and needless when an axis is not moving. A point whose value
 * matches both neighbours adds nothing to a piecewise-linear function, and an
 * axis that never changes collapses to a single constant.
 */
function frameExpr(times: number[], values: string[], fps: number): string {
  if (values.length === 0) return "0";
  if (values.length === 1) return values[0];

  const keptT: number[] = [times[0]];
  const keptV: string[] = [values[0]];
  for (let i = 1; i < values.length - 1; i++) {
    if (values[i] === keptV[keptV.length - 1] && values[i] === values[i + 1]) continue;
    keptT.push(times[i]);
    keptV.push(values[i]);
  }
  keptT.push(times[times.length - 1]);
  keptV.push(values[values.length - 1]);

  if (keptV.every((v) => v === keptV[0])) return keptV[0];

  const f = fps > 0 ? fps : 30;
  const at = (i: number) => (keptT[i] / 1000).toFixed(3);
  let expr = keptV[keptV.length - 1];
  for (let i = keptT.length - 2; i >= 0; i--) {
    const t0 = at(i);
    const t1 = at(i + 1);
    // `on/fps` is the elapsed output time; guard a zero-length segment.
    const span = Math.max(0.001, Number(t1) - Number(t0)).toFixed(3);
    const seg = `lerp(${keptV[i]},${keptV[i + 1]},clip((on/${f}-${t0})/${span},0,1))`;
    expr = `if(lt(on/${f},${t1}),${seg},${expr})`;
  }
  return expr;
}

/**
 * Build `zoompan` z/x/y expressions for an authored capture window.
 *
 * `zoompan` positions the *top-left* of the source region, so a normalised
 * centre becomes `iw*cx - (iw/zoom)/2`, clamped so the window never leaves the
 * frame — the same centring and clamping the `crop` path does.
 */
export function focusToZoompanExpr(
  samples: readonly (FocusSample & { atMs: number })[],
  { fps }: ZoompanOptions,
): ZoompanExpr {
  if (samples.length === 0) {
    return { z: "1", x: "0", y: "0" };
  }
  const sorted = [...samples].sort((a, b) => a.atMs - b.atMs);
  const times = sorted.map((s) => s.atMs);

  const zVals = sorted.map((s) => Math.max(1, s.scale).toFixed(4));
  // Written in terms of `zoom` so the clamp always matches the zoom actually
  // applied on that frame, including during a tween.
  const xVals = sorted.map(
    (s) => `clip(iw*${s.x.toFixed(4)}-(iw/zoom)/2,0,iw-iw/zoom)`,
  );
  const yVals = sorted.map(
    (s) => `clip(ih*${s.y.toFixed(4)}-(ih/zoom)/2,0,ih-ih/zoom)`,
  );

  return {
    z: frameExpr(times, zVals, fps),
    x: frameExpr(times, xVals, fps),
    y: frameExpr(times, yVals, fps),
  };
}
