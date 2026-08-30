import test from "node:test";
import assert from "node:assert/strict";

import {
  FOCUS_LIMITS,
  focusNeedsZoom,
  focusToFocalTrack,
  focusToSamples,
  parseFocusTrack,
  sampleFocusAt,
  serializeFocusTrack,
  type FocusKeyframe,
} from "../src/lib/focus/keyframes.ts";
import { focusToZoompanExpr } from "../src/lib/ffmpeg/track-crop.ts";
import { buildZoomReframeArgs } from "../src/lib/ffmpeg/args.ts";

const kf = (atMs: number, x: number, y: number, scale = 1, ease?: FocusKeyframe["ease"]) =>
  ({ atMs, x, y, scale, ...(ease ? { ease } : {}) }) as FocusKeyframe;

test("parseFocusTrack tolerates null / garbage and clamps into range", () => {
  assert.deepEqual(parseFocusTrack(null), []);
  assert.deepEqual(parseFocusTrack("not json"), []);
  assert.deepEqual(parseFocusTrack('"a string"'), []);
  // x/y clamp to the frame, scale to the usable zoom range.
  assert.deepEqual(parseFocusTrack('[{"atMs":0,"x":-5,"y":9,"scale":99}]'), [
    { atMs: 0, x: 0, y: 1, scale: FOCUS_LIMITS.scale.max },
  ]);
  // A window below 1 would be bigger than the frame and letterbox.
  assert.equal(parseFocusTrack('[{"atMs":0,"x":0.5,"y":0.5,"scale":0.2}]')[0].scale, 1);
  // Entries missing a coordinate carry no window and are dropped.
  assert.deepEqual(parseFocusTrack('[{"atMs":0,"x":0.5},{"atMs":"x","x":1,"y":1}]'), []);
});

test("parseFocusTrack accepts both a bare array and a keyframes object", () => {
  const a = parseFocusTrack('[{"atMs":0,"x":0.5,"y":0.5}]');
  const b = parseFocusTrack('{"keyframes":[{"atMs":0,"x":0.5,"y":0.5}]}');
  assert.deepEqual(a, b);
  assert.equal(a[0].scale, 1, "scale defaults to the full frame");
});

test("keyframes are stored sorted so sampling can scan in one pass", () => {
  const t = parseFocusTrack('[{"atMs":900,"x":0.9,"y":0.1},{"atMs":100,"x":0.1,"y":0.9}]');
  assert.deepEqual(
    t.map((k) => k.atMs),
    [100, 900],
  );
});

test("serializeFocusTrack drops an empty track and round-trips a real one", () => {
  assert.equal(serializeFocusTrack([]), null);
  const track = [kf(0, 0.2, 0.3, 1), kf(1000, 0.8, 0.7, 2, "out")];
  const json = serializeFocusTrack(track);
  assert.ok(json);
  assert.deepEqual(parseFocusTrack(json), track);
});

test("sampleFocusAt holds the edges and eases between keyframes", () => {
  const track = [kf(0, 0, 0, 1), kf(1000, 1, 1, 2, "linear")];
  // Before the first / after the last keyframe the window holds still.
  assert.deepEqual(sampleFocusAt(track, -500), { x: 0, y: 0, scale: 1 });
  assert.deepEqual(sampleFocusAt(track, 5000), { x: 1, y: 1, scale: 2 });
  // Linear easing puts the midpoint exactly halfway on every axis.
  assert.deepEqual(sampleFocusAt(track, 500), { x: 0.5, y: 0.5, scale: 1.5 });
});

test("a single keyframe is a valid static reframe", () => {
  const track = [kf(4000, 0.25, 0.75, 1.5)];
  for (const ms of [0, 4000, 99999]) {
    assert.deepEqual(sampleFocusAt(track, ms), { x: 0.25, y: 0.75, scale: 1.5 });
  }
});

test("an empty track reads as the centre of the frame, never NaN", () => {
  assert.deepEqual(sampleFocusAt([], 1234), { x: 0.5, y: 0.5, scale: 1 });
});

test("two keyframes at the same instant are a hard cut, not a divide by zero", () => {
  const track = [kf(0, 0, 0, 1), kf(1000, 0.2, 0.2, 1), kf(1000, 0.9, 0.9, 2)];
  const at = sampleFocusAt(track, 1000);
  assert.ok(Number.isFinite(at.x) && Number.isFinite(at.scale));
  assert.deepEqual(at, { x: 0.9, y: 0.9, scale: 2 });
});

test("easing changes the curve but never the endpoints", () => {
  const linear = [kf(0, 0, 0, 1), kf(1000, 1, 1, 1, "linear")];
  const eased = [kf(0, 0, 0, 1), kf(1000, 1, 1, 1, "out")];
  assert.equal(sampleFocusAt(linear, 250).x, 0.25);
  // ease-out is ahead of linear at the same instant.
  assert.ok(sampleFocusAt(eased, 250).x > 0.25);
  for (const track of [linear, eased]) {
    assert.equal(sampleFocusAt(track, 0).x, 0);
    assert.equal(sampleFocusAt(track, 1000).x, 1);
  }
});

test("focusNeedsZoom only fires when the window actually zooms", () => {
  assert.equal(focusNeedsZoom([]), false);
  assert.equal(focusNeedsZoom([kf(0, 0.5, 0.5, 1), kf(1000, 0.2, 0.2, 1)]), false);
  assert.equal(focusNeedsZoom([kf(0, 0.5, 0.5, 1), kf(1000, 0.2, 0.2, 1.5)]), true);
});

test("focusToFocalTrack bakes easing into evenly spaced points and pins the end", () => {
  const track = [kf(0, 0, 0.5, 1), kf(1000, 1, 0.5, 1, "linear")];
  const pts = focusToFocalTrack(track, 1000, 250);
  assert.deepEqual(
    pts.map((p) => p.atMs),
    [0, 250, 500, 750, 1000],
  );
  assert.equal(pts[2].x, 0.5, "easing is resolved in the samples, not the expression");
  // A duration that is not a multiple of the step still ends exactly on time.
  const ragged = focusToFocalTrack(track, 900, 250);
  assert.equal(ragged[ragged.length - 1].atMs, 900);
  assert.deepEqual(focusToFocalTrack([], 1000), [], "no window -> no track");
});

test("focusToZoompanExpr centres and clamps the window inside the frame", () => {
  const samples = focusToSamples([kf(0, 0.5, 0.5, 2)], 1000, 500);
  const e = focusToZoompanExpr(samples, { width: 1080, height: 1920, fps: 30 });
  assert.equal(e.z, "2.0000", "a constant zoom collapses to a constant");
  // Positions the top-left of the source region, clamped so it cannot leave.
  assert.match(e.x, /clip\(iw\*0\.5000-\(iw\/zoom\)\/2,0,iw-iw\/zoom\)/);
  assert.match(e.y, /clip\(ih\*0\.5000-\(ih\/zoom\)\/2,0,ih-ih\/zoom\)/);
});

test("focusToZoompanExpr interpolates on output frames, not wall time", () => {
  const samples = focusToSamples([kf(0, 0.5, 0.5, 1), kf(1000, 0.5, 0.5, 2, "linear")], 1000, 500);
  const e = focusToZoompanExpr(samples, { width: 1080, height: 1920, fps: 30 });
  // zoompan evaluates per output frame, so elapsed time is `on/fps`.
  assert.match(e.z, /on\/30/);
  assert.match(e.z, /lerp\(/);
  assert.ok(!e.z.includes("(t-"), "the crop path's `t` must not leak in here");
});

test("a static axis collapses instead of nesting one if() per sample", () => {
  // 20s of dense samples, panning horizontally at a constant zoom.
  const samples = focusToSamples([kf(0, 0, 0.5, 2), kf(20000, 1, 0.5, 2, "linear")], 20000, 250);
  assert.ok(samples.length > 70, "the window really is densely sampled");
  const e = focusToZoompanExpr(samples, { width: 1080, height: 1920, fps: 30 });
  assert.equal(e.z, "2.0000", "zoom never changes -> one constant");
  assert.ok(!e.y.includes("if("), "y never changes -> no branches");
  // x is the only axis that actually moves, and it stays a manageable size.
  assert.ok(e.x.includes("if("), "x moves, so it keeps its ramp");
  assert.ok(e.x.length < 12000, `x expression is ${e.x.length} chars`);
});

test("an empty window yields a no-op zoompan rather than a broken expression", () => {
  assert.deepEqual(focusToZoompanExpr([], { width: 1080, height: 1920, fps: 30 }), {
    z: "1",
    x: "0",
    y: "0",
  });
});

test("buildZoomReframeArgs escapes commas and pins one frame per input frame", () => {
  const samples = focusToSamples([kf(0, 0.5, 0.5, 1), kf(1000, 0.3, 0.3, 2)], 1000, 500);
  const e = focusToZoompanExpr(samples, { width: 1080, height: 1920, fps: 30 });
  const args = buildZoomReframeArgs({
    inputPath: "/tmp/in.mp4",
    outputPath: "/tmp/out.mp4",
    aspect: "9:16",
    zoomZ: e.z,
    zoomX: e.x,
    zoomY: e.y,
    fps: 30,
  });
  const fc = args[args.indexOf("-filter_complex") + 1];
  assert.match(fc, /zoompan=/);
  assert.match(fc, /d=1/, "without d=1 zoompan holds each frame for 90 and the clip runs long");
  assert.match(fc, /s=1080x1920/);
  assert.ok(!/[^\\],/.test(fc.split("zoompan=")[1].split(":d=1")[0]), "commas inside the expression are escaped");
  assert.equal(args[args.length - 1], "/tmp/out.mp4");
});

test("buildZoomReframeArgs rejects unusable inputs rather than emitting bad filters", () => {
  const base = {
    inputPath: "/tmp/in.mp4",
    outputPath: "/tmp/out.mp4",
    aspect: "9:16" as const,
    zoomZ: "1",
    zoomX: "0",
    zoomY: "0",
    fps: 30,
  };
  assert.throws(() => buildZoomReframeArgs({ ...base, zoomZ: "" }), /required/);
  assert.throws(() => buildZoomReframeArgs({ ...base, fps: 0 }), /bad fps/);
});
