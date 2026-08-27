import test from "node:test";
import assert from "node:assert/strict";

import { focalTrackToCropExpr } from "../src/lib/ffmpeg/track-crop.ts";
import type { FocalPoint } from "../src/lib/faces/track.ts";

const p = (atMs: number, x: number, y: number): FocalPoint => ({ atMs, x, y });

test("an empty track produces a static centre crop expression", () => {
  const { x, y } = focalTrackToCropExpr([], { width: 1080, height: 1920 });
  assert.equal(x, "clip(in_w*0.5000-540,0,in_w-1080)");
  assert.equal(y, "clip(in_h*0.5000-960,0,in_h-1920)");
});

test("a single keyframe is just that point's clamped coordinate", () => {
  const { x } = focalTrackToCropExpr([p(0, 0.62, 0.4)], { width: 1080, height: 1920 });
  assert.equal(x, "clip(in_w*0.6200-540,0,in_w-1080)");
});

test("multiple keyframes nest lerp segments guarded by time windows", () => {
  const { x } = focalTrackToCropExpr(
    [p(0, 0.2, 0.5), p(1000, 0.8, 0.5), p(2500, 0.4, 0.5)],
    { width: 1080, height: 1920 },
  );
  // one `if(lt(t,...))` per gap, one `lerp(` per gap
  assert.equal((x.match(/if\(lt\(t,/g) ?? []).length, 2);
  assert.equal((x.match(/lerp\(/g) ?? []).length, 2);
  assert.match(x, /if\(lt\(t,1\.000\),/);
  assert.match(x, /if\(lt\(t,2\.500\),/);
  // last segment holds the final point (followed only by the closing parens)
  assert.match(x, /clip\(in_w\*0\.4000-540,0,in_w-1080\)\)+$/);
});

test("keyframes are sorted by time before building the expression", () => {
  const { x } = focalTrackToCropExpr([p(2000, 0.9, 0.5), p(0, 0.1, 0.5)], { width: 100, height: 100 });
  assert.match(x, /^if\(lt\(t,2\.000\),lerp\(clip\(in_w\*0\.1000/);
});
