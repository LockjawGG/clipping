import test from "node:test";
import assert from "node:assert/strict";

import {
  insertionIndex,
  itemDurationMs,
  laneDurationMs,
  packLanes,
  sequenceDurationMs,
} from "../src/lib/sequence/lane.ts";
import {
  buildComposePlan,
  buildLayerPlan,
  isPlainCut,
  mapSourceToTimeline,
  planDurationMs,
  remapWordsToTimeline,
  type ComposableItem,
} from "../src/lib/sequence/compose.ts";
import { buildConcatArgs, buildVideoLayerArgs, concatListLine } from "../src/lib/ffmpeg/args.ts";

const item = (over: Partial<ComposableItem> & { id: string }): ComposableItem => ({
  trackId: "v1",
  order: 0,
  sourceIn: 0,
  sourceOut: 1_000,
  sourceVideoId: "vid",
  sourceAssetId: null,
  ...over,
});

test("a lane lays its pieces end to end, so adding media lengthens the timeline", () => {
  const a = item({ id: "a", order: 0, sourceIn: 0, sourceOut: 4_000 });
  const b = item({ id: "b", order: 1, sourceIn: 10_000, sourceOut: 16_000 });

  assert.equal(laneDurationMs([a], "v1"), 4_000);
  // Dropping b in makes the lane exactly as much longer as b is.
  assert.equal(laneDurationMs([a, b], "v1"), 10_000);

  const packed = packLanes([a, b]);
  assert.equal(packed.get("a"), 0);
  assert.equal(packed.get("b"), 4_000, "b starts where a ends — no gap to drag out");
});

test("trimming a piece pulls the rest back", () => {
  const a = item({ id: "a", order: 0, sourceIn: 0, sourceOut: 4_000 });
  const b = item({ id: "b", order: 1, sourceIn: 0, sourceOut: 2_000 });
  assert.equal(packLanes([a, b]).get("b"), 4_000);

  // a is trimmed to a second: b follows it up rather than leaving a hole.
  const trimmed = { ...a, sourceOut: 1_000 };
  assert.equal(packLanes([trimmed, b]).get("b"), 1_000);
  assert.equal(laneDurationMs([trimmed, b], "v1"), 3_000);
});

test("lanes run in parallel, so the sequence is as long as its longest one", () => {
  const items = [
    item({ id: "a", trackId: "v1", order: 0, sourceOut: 5_000 }),
    item({ id: "b", trackId: "v2", order: 0, sourceOut: 2_000 }),
    item({ id: "c", trackId: "v2", order: 1, sourceOut: 2_000 }),
  ];
  const packed = packLanes(items);
  assert.equal(packed.get("b"), 0, "each lane packs from zero");
  assert.equal(packed.get("c"), 2_000);
  assert.equal(sequenceDurationMs(items), 5_000);
});

test("a drop resolves to a position in the lane, not a pixel offset", () => {
  const items = [
    item({ id: "a", order: 0, sourceOut: 4_000 }),
    item({ id: "b", order: 1, sourceOut: 4_000 }),
  ];
  assert.equal(insertionIndex(items, "v1", 500), 0, "before the middle of a → first");
  assert.equal(insertionIndex(items, "v1", 3_000), 1, "past a's midpoint → after a");
  assert.equal(insertionIndex(items, "v1", 7_000), 2, "past b's midpoint → last");
  // A piece being dragged does not count as its own neighbour.
  assert.equal(insertionIndex(items, "v1", 7_000, "b"), 1);
});

test("the plan is the lane in order, and an untouched timeline is still a plain cut", () => {
  const clip = { videoId: "vid", startMs: 10_000, endMs: 20_000 };
  const untouched = [item({ id: "a", sourceIn: 10_000, sourceOut: 20_000 })];
  assert.equal(isPlainCut(buildComposePlan(untouched, "v1"), clip), true);

  // Split in two: same footage, but no longer a single cut.
  const split = [
    item({ id: "a", order: 0, sourceIn: 10_000, sourceOut: 14_000 }),
    item({ id: "b", order: 1, sourceIn: 14_000, sourceOut: 20_000 }),
  ];
  const plan = buildComposePlan(split, "v1");
  assert.equal(isPlainCut(plan, clip), false);
  assert.deepEqual(
    plan.map((p) => [p.timelineStart, p.durationMs]),
    [[0, 4_000], [4_000, 6_000]],
  );
  assert.equal(planDurationMs(plan), 10_000);
});

test("dropping the middle out of a clip shortens the output", () => {
  // Keep 0-2s and 8-10s of a ten second clip: four seconds, not ten.
  const plan = buildComposePlan(
    [
      item({ id: "a", order: 0, sourceIn: 0, sourceOut: 2_000 }),
      item({ id: "b", order: 1, sourceIn: 8_000, sourceOut: 10_000 }),
    ],
    "v1",
  );
  assert.equal(planDurationMs(plan), 4_000);
  assert.equal(mapSourceToTimeline(plan, "vid", 8_500), 2_500, "the second piece follows the first");
  assert.equal(mapSourceToTimeline(plan, "vid", 5_000), null, "the dropped middle maps nowhere");
  assert.equal(mapSourceToTimeline(plan, "other", 1_000), null, "a different source is not ours");
});

test("an item with no video keeps its place without pretending to be footage", () => {
  const plan = buildComposePlan(
    [
      item({ id: "a", order: 0, sourceOut: 2_000 }),
      item({ id: "img", order: 1, sourceOut: 3_000, sourceVideoId: null, sourceAssetId: "asset" }),
      item({ id: "b", order: 2, sourceIn: 0, sourceOut: 1_000 }),
    ],
    "v1",
  );
  assert.equal(plan.length, 2, "the asset is not cut");
  assert.equal(plan[1].timelineStart, 5_000, "but its time is still reserved");
});

test("words follow their footage, and words in trimmed-out ranges disappear", () => {
  const plan = buildComposePlan(
    [
      item({ id: "a", order: 0, sourceIn: 0, sourceOut: 2_000 }),
      item({ id: "b", order: 1, sourceIn: 8_000, sourceOut: 10_000 }),
    ],
    "v1",
  );
  const words = [
    { id: "w1", text: "kept", startMs: 500, endMs: 900 },
    { id: "w2", text: "cut", startMs: 5_000, endMs: 5_400 },
    { id: "w3", text: "moved", startMs: 8_500, endMs: 8_900 },
  ];
  // offsetMs is the clip's own startMs: words come back in the same absolute
  // space the renderer already rebases, so nothing downstream has to change.
  const out = remapWordsToTimeline(words, plan, "vid", 100_000);
  assert.deepEqual(out.map((w) => w.id), ["w1", "w3"], "the trimmed word is gone");
  assert.equal(out[0].startMs, 100_500);
  assert.equal(out[1].startMs, 102_500, "8.5s of source is 2.5s into the output");
});

test("a word running past its cut is clamped to it", () => {
  const plan = buildComposePlan([item({ id: "a", sourceIn: 0, sourceOut: 2_000 })], "v1");
  const [w] = remapWordsToTimeline(
    [{ id: "w", text: "straddles", startMs: 1_900, endMs: 2_600 }],
    plan,
    "vid",
    0,
  );
  assert.equal(w.endMs, 2_000, "a censor span must not run past the join into other footage");
});

test("concat copies streams when it can and re-encodes when it must", () => {
  const copy = buildConcatArgs({ listPath: "/tmp/l.txt", outputPath: "/tmp/o.mp4" });
  assert.ok(copy.includes("concat") && copy.includes("-safe"));
  assert.deepEqual(copy.slice(copy.indexOf("-c"), copy.indexOf("-c") + 2), ["-c", "copy"]);

  const re = buildConcatArgs({ listPath: "/tmp/l.txt", outputPath: "/tmp/o.mp4", reencode: true });
  assert.ok(re.includes("libx264") && !re.includes("copy"));
});

test("concat list quoting survives the paths Windows actually produces", () => {
  assert.equal(concatListLine("/tmp/a b/c.mp4"), "file '/tmp/a b/c.mp4'");
  assert.equal(concatListLine("C:/Users/x/My Videos/p.mp4"), "file 'C:/Users/x/My Videos/p.mp4'");
  assert.throws(() => concatListLine("relative.mp4"), /absolute/);
});

test("itemDurationMs never goes negative", () => {
  assert.equal(itemDurationMs({ sourceIn: 500, sourceOut: 100 }), 0);
});

test("the base lane is composed; the others are laid over it", () => {
  const items = [
    item({ id: "b0", trackId: "v1", order: 0, sourceIn: 0, sourceOut: 8_000 }),
    item({ id: "u0", trackId: "v2", order: 0, sourceIn: 20_000, sourceOut: 22_000 }),
    item({ id: "u1", trackId: "v2", order: 1, sourceIn: 30_000, sourceOut: 31_000 }),
  ];
  const base = buildComposePlan(items, "v1");
  const layers = buildLayerPlan(items, "v1", ["v1", "v2"]);

  assert.equal(base.length, 1, "the base lane holds only its own pieces");
  assert.deepEqual(
    layers.map((l) => [l.timelineStart, l.durationMs]),
    [[0, 2_000], [2_000, 1_000]],
    "and the upper lane packs from zero, exactly like the base",
  );
});

test("layer args place each piece in time and fit it to the frame", () => {
  const args = buildVideoLayerArgs({
    inputPath: "/tmp/base.mp4",
    outputPath: "/tmp/out.mp4",
    width: 1080,
    height: 1920,
    layers: [{ path: "/tmp/l0.mp4", startSec: 0 }, { path: "/tmp/l1.mp4", startSec: 2.5 }],
  });
  const filter = args[args.indexOf("-filter_complex") + 1];

  // Without the PTS shift every layer would play from the top of the timeline.
  assert.match(filter, /setpts=PTS-STARTPTS\+0\/TB\[l0\]/);
  assert.match(filter, /setpts=PTS-STARTPTS\+2\.5\/TB\[l1\]/);
  // Fitted and padded, not cropped — a differently shaped source keeps its edges.
  assert.match(filter, /force_original_aspect_ratio=decrease/);
  assert.match(filter, /pad=1080:1920/);
  // The base runs on after a layer ends.
  assert.match(filter, /eof_action=pass:shortest=0/);
  // The base keeps its own audio.
  assert.deepEqual(args.slice(args.indexOf("-c:a"), args.indexOf("-c:a") + 2), ["-c:a", "copy"]);
});
