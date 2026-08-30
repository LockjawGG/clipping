import test from "node:test";
import assert from "node:assert/strict";

import {
  applyInteriorCuts,
  cutDurationMs,
  cutSpansForWords,
  mergeSpans,
  MIN_KEEP_MS,
  SEAM_PAD_MS,
} from "../src/lib/sequence/cuts.ts";
import { planDurationMs, remapWordsToTimeline, type ComposePiece } from "../src/lib/sequence/compose.ts";

const V = "vid-1";

function piece(sourceIn: number, sourceOut: number, timelineStart: number): ComposePiece {
  return {
    sourceVideoId: V,
    sourceStorageKey: "key",
    sourceIn,
    sourceOut,
    timelineStart,
    durationMs: sourceOut - sourceIn,
  };
}

/** "So the thing is, um, we shipped it Friday." with realistic gaps. */
function sentence() {
  return [
    { id: "w1", text: "So", startMs: 1_000, endMs: 1_200 },
    { id: "w2", text: "the", startMs: 1_260, endMs: 1_400 },
    { id: "w3", text: "thing", startMs: 1_440, endMs: 1_800 },
    { id: "w4", text: "is,", startMs: 1_840, endMs: 2_100 },
    { id: "um", text: "um,", startMs: 2_400, endMs: 2_800 },
    { id: "w5", text: "we", startMs: 3_100, endMs: 3_260 },
    { id: "w6", text: "shipped", startMs: 3_300, endMs: 3_800 },
    { id: "w7", text: "it", startMs: 3_840, endMs: 3_960 },
    { id: "w8", text: "Friday.", startMs: 4_000, endMs: 4_500 },
  ];
}

test("striking a word takes half the silence on each side of it", () => {
  const [span] = cutSpansForWords(sentence(), ["um"], V);

  // 300ms of silence sits on each side of "um"; half of each goes with it.
  assert.equal(span.startMs, 2_250);
  assert.equal(span.endMs, 2_950);

  // What is left at the seam is one ordinary word gap, not the two stacked
  // pauses you get from cutting the word at its own boundaries.
  const gapLeft = 3_100 - 2_950 + (2_250 - 2_100);
  assert.equal(gapLeft, 300);
  // And nothing of the kept words on either side was touched.
  assert.ok(span.startMs > 2_100 && span.endMs < 3_100);
});

test("the reach into silence is capped so a deliberate pause survives", () => {
  const words = [
    { id: "a", text: "one", startMs: 0, endMs: 500 },
    { id: "b", text: "two", startMs: 4_000, endMs: 4_400 }, // after a 3.5s pause
    { id: "c", text: "three", startMs: 8_000, endMs: 8_400 },
  ];
  const [span] = cutSpansForWords(words, ["b"], V);

  assert.equal(span.startMs, 4_000 - SEAM_PAD_MS);
  assert.equal(span.endMs, 4_400 + SEAM_PAD_MS);
  // Half of 3.5s would have been 1.75s a side. The pause is the point of the
  // shot, so what survives it is most of the silence, not a snipped beat.
  const pauseLeft = span.startMs - 500 + (8_000 - span.endMs);
  assert.equal(pauseLeft, 3_500 + 3_600 - 2 * SEAM_PAD_MS);
  assert.ok(pauseLeft > 6_000);
});

test("a run of struck words closes up completely", () => {
  const words = [
    { id: "a", text: "so", startMs: 0, endMs: 300 },
    { id: "um", text: "um", startMs: 400, endMs: 600 },
    { id: "uh", text: "uh", startMs: 700, endMs: 900 },
    { id: "b", text: "yes", startMs: 1_000, endMs: 1_300 },
  ];
  const spans = cutSpansForWords(words, ["um", "uh"], V);

  // The two halves of the gap between them meet, so it is one cut, not two
  // with a 100ms sliver stranded in the middle.
  assert.equal(spans.length, 1);
  assert.equal(spans[0].startMs, 350);
  assert.equal(spans[0].endMs, 950);
});

test("unknown ids and words with no id are ignored", () => {
  assert.deepEqual(cutSpansForWords(sentence(), ["nope"], V), []);
  assert.deepEqual(cutSpansForWords(sentence(), [], V), []);
  const anonymous = [{ text: "hi", startMs: 0, endMs: 100 }];
  assert.deepEqual(cutSpansForWords(anonymous, ["anything"], V), []);
});

test("a cut splits the piece it lands in and the rest closes up", () => {
  const plan = [piece(1_000, 5_000, 0)];
  const after = applyInteriorCuts(plan, [{ sourceVideoId: V, startMs: 2_250, endMs: 2_950 }]);

  assert.equal(after.length, 2);
  assert.deepEqual(
    after.map((p) => [p.sourceIn, p.sourceOut, p.timelineStart]),
    [
      [1_000, 2_250, 0],
      [2_950, 5_000, 1_250],
    ],
  );
  // The output is shorter by exactly what was removed — no gap left behind.
  assert.equal(planDurationMs(after), 4_000 - 700);
});

test("cuts only touch the source they name", () => {
  const other: ComposePiece = { ...piece(0, 2_000, 4_000), sourceVideoId: "vid-2" };
  const after = applyInteriorCuts(
    [piece(0, 4_000, 0), other],
    [{ sourceVideoId: V, startMs: 1_000, endMs: 2_000 }],
  );

  // The second video is untouched, but it moves up by the second that was
  // taken out of the first — it plays after it.
  const second = after.filter((p) => p.sourceVideoId === "vid-2");
  assert.equal(second.length, 1);
  assert.deepEqual([second[0].sourceIn, second[0].sourceOut], [0, 2_000]);
  assert.equal(second[0].timelineStart, 3_000);
});

test("a fragment too short to hear goes with the cuts that isolated it", () => {
  const plan = [piece(0, 10_000, 0)];
  const after = applyInteriorCuts(plan, [
    { sourceVideoId: V, startMs: 2_000, endMs: 3_000 },
    // Leaves an 80ms sliver between the two cuts.
    { sourceVideoId: V, startMs: 3_080, endMs: 4_000 },
  ]);

  assert.equal(after.length, 2);
  assert.ok(after.every((p) => p.durationMs >= MIN_KEEP_MS));
  // The sliver went too, so the output is 80ms shorter than the cuts alone.
  assert.equal(planDurationMs(after), 10_000 - 1_000 - 920 - 80);

  // Same rule at the edges: a cut starting just inside the piece takes the
  // head with it rather than leaving an unplayable stub.
  const head = applyInteriorCuts(plan, [{ sourceVideoId: V, startMs: 50, endMs: 2_000 }]);
  assert.equal(head.length, 1);
  assert.equal(head[0].sourceIn, 2_000);
  assert.equal(head[0].timelineStart, 0);
});

test("cutting everything leaves nothing, and says so by being empty", () => {
  const after = applyInteriorCuts([piece(0, 3_000, 0)], [
    { sourceVideoId: V, startMs: 0, endMs: 3_000 },
  ]);
  assert.deepEqual(after, []);
  assert.equal(planDurationMs(after), 0);
});

test("captions follow the cut without any work of their own", () => {
  const words = sentence();
  const spans = cutSpansForWords(words, ["um"], V);
  const after = applyInteriorCuts([piece(1_000, 5_000, 0)], spans);

  // Words are remapped through the plan the renderer already used, so the
  // struck word is simply not in the result and everything after it moves up.
  // offsetMs is the clip start, exactly as the renderer passes it: times come
  // back source-absolute for every consumer downstream.
  const remapped = remapWordsToTimeline(words, after, V, 1_000);
  assert.equal(remapped.find((w) => w.id === "um"), undefined);
  assert.equal(remapped.length, words.length - 1);

  const shipped = remapped.find((w) => w.id === "w6");
  assert.equal(shipped?.startMs, 3_300 - 700);
  // Still in order, still the same spoken gaps between the survivors.
  const we = remapped.find((w) => w.id === "w5");
  assert.equal((shipped?.startMs ?? 0) - (we?.endMs ?? 0), 3_300 - 3_260);
});

test("mergeSpans keeps sources apart and joins what touches", () => {
  const merged = mergeSpans([
    { sourceVideoId: "b", startMs: 0, endMs: 100 },
    { sourceVideoId: "a", startMs: 500, endMs: 900 },
    { sourceVideoId: "a", startMs: 900, endMs: 1_200 }, // touching
    { sourceVideoId: "a", startMs: 100, endMs: 400 },
    { sourceVideoId: "b", startMs: 50, endMs: 300 }, // overlapping
  ]);
  assert.deepEqual(merged, [
    { sourceVideoId: "a", startMs: 100, endMs: 400 },
    { sourceVideoId: "a", startMs: 500, endMs: 1_200 },
    { sourceVideoId: "b", startMs: 0, endMs: 300 },
  ]);
});

test("cutDurationMs is what the clip loses, slivers included", () => {
  const plan = [piece(0, 10_000, 0)];
  assert.equal(cutDurationMs(plan, []), 0);
  assert.equal(cutDurationMs(plan, [{ sourceVideoId: V, startMs: 1_000, endMs: 1_500 }]), 500);
  assert.equal(
    cutDurationMs(plan, [
      { sourceVideoId: V, startMs: 2_000, endMs: 3_000 },
      { sourceVideoId: V, startMs: 3_080, endMs: 4_000 },
    ]),
    2_000,
  );
});
