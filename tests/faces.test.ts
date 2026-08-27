import test from "node:test";
import assert from "node:assert/strict";

import {
  clampPoint,
  resampleTrack,
  sampleFocalAt,
  smoothTrack,
  type FocalPoint,
} from "../src/lib/faces/track.ts";
import { NullFaceDetector } from "../src/lib/faces/detector.ts";

const p = (atMs: number, x: number, y: number): FocalPoint => ({ atMs, x, y });

test("clampPoint pins x/y into 0..1 and rounds the time", () => {
  assert.deepEqual(clampPoint({ atMs: 12.6, x: 1.4, y: -0.2 }), { atMs: 13, x: 1, y: 0 });
  assert.deepEqual(clampPoint({ atMs: -5, x: Number.NaN, y: 0.3 }), { atMs: 0, x: 0.5, y: 0.3 });
});

test("smoothTrack sorts, clamps, and eases toward each new sample", () => {
  const out = smoothTrack([p(1000, 0.9, 0.5), p(0, 0.1, 0.5), p(2000, 0.9, 0.5)], 0.5);
  assert.deepEqual(
    out.map((q) => q.atMs),
    [0, 1000, 2000],
  );
  assert.equal(out[0].x, 0.1);
  assert.ok(out[1].x > 0.1 && out[1].x < 0.9); // eased, not snapped
  assert.ok(out[2].x > out[1].x);
});

test("smoothTrack passes through 0 or 1 point unchanged (but clamped)", () => {
  assert.deepEqual(smoothTrack([]), []);
  assert.deepEqual(smoothTrack([p(10, 2, -1)]), [{ atMs: 10, x: 1, y: 0 }]);
});

test("sampleFocalAt interpolates between keyframes and holds at the ends", () => {
  const track = [p(0, 0.2, 0.2), p(1000, 0.8, 0.6)];
  assert.deepEqual(sampleFocalAt(track, -100), { atMs: -100, x: 0.2, y: 0.2 });
  assert.deepEqual(sampleFocalAt(track, 2000), { atMs: 2000, x: 0.8, y: 0.6 });
  const mid = sampleFocalAt(track, 500);
  assert.ok(Math.abs(mid.x - 0.5) < 1e-9);
  assert.ok(Math.abs(mid.y - 0.4) < 1e-9);
});

test("sampleFocalAt on an empty track returns the centre", () => {
  assert.deepEqual(sampleFocalAt([], 400), { atMs: 400, x: 0.5, y: 0.5 });
});

test("resampleTrack yields one point per step across the duration, or nothing when empty", () => {
  const out = resampleTrack([p(0, 0.3, 0.3), p(2000, 0.7, 0.7)], 2000, 500);
  assert.deepEqual(
    out.map((q) => q.atMs),
    [0, 500, 1000, 1500, 2000],
  );
  assert.deepEqual(resampleTrack([], 5000), []);
});

test("NullFaceDetector detects nothing", async () => {
  const d = new NullFaceDetector();
  assert.equal(d.name, "none");
  assert.deepEqual(await d.detectTrack("/tmp/x.mp4", { durationMs: 1000 }), []);
});
