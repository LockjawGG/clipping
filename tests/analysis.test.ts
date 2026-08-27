import test from "node:test";
import assert from "node:assert/strict";

import type { ClipSuggestion, Segment } from "../src/lib/providers/types.ts";
import { buildTranscriptText, parseClipArray } from "../src/lib/analysis/prompt.ts";
import { refineSuggestions } from "../src/lib/analysis/pipeline.ts";
import { HeuristicAnalysisProvider } from "../src/lib/analysis/heuristic.ts";

function seg(startMs: number, endMs: number, text: string): Segment {
  return { startMs, endMs, text, words: [] };
}

const TRANSCRIPT: Segment[] = [
  seg(0, 12_000, "Intro chatter here."),
  seg(12_000, 26_000, "Now the really interesting part starts."),
  seg(26_000, 40_000, "And it keeps going with a great point."),
  seg(40_000, 55_000, "Here is a strong conclusion to that idea."),
  seg(55_000, 70_000, "Totally new topic begins now."),
  seg(70_000, 86_000, "This one has a surprising twist in it."),
  seg(86_000, 100_000, "Wrapping up the twist with more detail."),
  seg(100_000, 118_000, "Final outro remarks and goodbye."),
];
const DURATION = 120_000;

function suggestion(over: Partial<ClipSuggestion>): ClipSuggestion {
  return {
    startMs: 0,
    endMs: 1,
    title: "x",
    hook: "",
    description: "",
    reason: "",
    caption: "",
    socialTitle: "",
    hashtags: [],
    score: 0.5,
    ...over,
  };
}

// --- prompt / parsing ------------------------------------------------

test("buildTranscriptText numbers and timestamps each segment", () => {
  const text = buildTranscriptText(TRANSCRIPT.slice(0, 2));
  assert.match(text, /^#0 \[0:00-0:12\] Intro chatter here\./);
  assert.match(text, /#1 \[0:12-0:26\] Now the really interesting/);
});

test("parseClipArray fills defaults, strips '#', clamps score, drops inverted spans", () => {
  const out = parseClipArray({
    clips: [
      { startMs: 1000, endMs: 5000, title: "Good clip", hashtags: ["#ai", "clips"], score: 9 },
      { startMs: 8000, endMs: 8000, title: "Zero length" },
      { startMs: 10_000, endMs: 9000, title: "Inverted" },
    ],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "Good clip");
  assert.equal(out[0].socialTitle, "Good clip"); // falls back to title
  assert.deepEqual(out[0].hashtags, ["ai", "clips"]);
  assert.equal(out[0].score, 1); // clamped from 9
  assert.equal(out[0].hook, ""); // default
});

test("parseClipArray rejects input missing required fields", () => {
  assert.throws(() => parseClipArray({ clips: [{ startMs: 0 }] }));
  assert.throws(() => parseClipArray({ notClips: [] }));
});

// --- refine pipeline ----------------------------------------------

test("refineSuggestions snaps a mid-sentence window to sentence + pad boundaries", () => {
  const [clip] = refineSuggestions(
    [suggestion({ startMs: 15_000, endMs: 38_000, title: "AAA", score: 0.6 })],
    TRANSCRIPT,
    DURATION,
    { minClipMs: 15_000, maxClipMs: 45_000, maxClips: 5, maxTotalRatio: 0.5 },
  );
  // segments 1..2 -> 12000..40000, padded by the snap defaults (250 / 400)
  assert.equal(clip.startMs, 12_000 - 250);
  assert.equal(clip.endMs, 40_000 + 400);
  assert.equal(clip.title, "AAA");
});

test("refineSuggestions drops overlaps (keeps higher score) and honours maxClips", () => {
  const raw = [
    suggestion({ startMs: 15_000, endMs: 38_000, title: "AAA", score: 0.6 }),
    suggestion({ startMs: 20_000, endMs: 42_000, title: "BBB", score: 0.9 }), // overlaps AAA
    suggestion({ startMs: 72_000, endMs: 98_000, title: "CCC", score: 0.7 }),
    suggestion({ startMs: 101_000, endMs: 117_000, title: "DDD", score: 0.4 }),
  ];
  const out = refineSuggestions(raw, TRANSCRIPT, DURATION, {
    minClipMs: 15_000,
    maxClipMs: 45_000,
    maxClips: 2,
    maxTotalRatio: 0.8,
  });
  assert.deepEqual(out.map((c) => c.title), ["BBB", "CCC"]); // AAA lost to overlap, DDD to maxClips
  assert.ok(out[0].startMs < out[1].startMs); // timeline order
});

test("refineSuggestions caps total runtime as a share of the source", () => {
  const raw = [
    suggestion({ startMs: 13_000, endMs: 39_000, title: "one", score: 0.9 }),
    suggestion({ startMs: 56_000, endMs: 84_000, title: "two", score: 0.8 }),
    suggestion({ startMs: 87_000, endMs: 117_000, title: "three", score: 0.7 }),
  ];
  const out = refineSuggestions(raw, TRANSCRIPT, DURATION, {
    minClipMs: 15_000,
    maxClipMs: 45_000,
    maxClips: 10,
    maxTotalRatio: 0.25, // 30s budget
  });
  const total = out.reduce((n, c) => n + (c.endMs - c.startMs), 0);
  assert.ok(total <= 0.25 * DURATION + 650, `total ${total}ms over budget`);
  assert.ok(out.length >= 1);
});

test("refineSuggestions keeps the best clip even when it alone exceeds the runtime budget", () => {
  // Overlapping picks collapse to one clip that spans most of the video;
  // a 20% budget can't hold it, but returning nothing would be worse.
  const raw = [
    suggestion({ startMs: 2_000, endMs: 115_000, title: "whole", score: 0.7 }),
    suggestion({ startMs: 5_000, endMs: 110_000, title: "also whole", score: 0.6 }),
  ];
  const out = refineSuggestions(raw, TRANSCRIPT, DURATION, {
    minClipMs: 15_000,
    maxClipMs: 200_000,
    maxClips: 5,
    maxTotalRatio: 0.2,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "whole");
  assert.ok(out[0].endMs - out[0].startMs > 0.2 * DURATION);
});

test("refineSuggestions returns nothing for empty input", () => {
  assert.deepEqual(refineSuggestions([], TRANSCRIPT, DURATION, { minClipMs: 1, maxClipMs: 9e9, maxClips: 5 }), []);
  assert.deepEqual(
    refineSuggestions([suggestion({ startMs: 0, endMs: 5000 })], [], DURATION, {
      minClipMs: 1,
      maxClipMs: 9e9,
      maxClips: 5,
    }),
    [],
  );
});

// --- heuristic provider -----------------------------------------

test("heuristic provider returns scored, in-range raw candidates", async () => {
  const provider = new HeuristicAnalysisProvider();
  const out = await provider.suggestClips(TRANSCRIPT, {
    minClipMs: 15_000,
    maxClipMs: 45_000,
    maxClips: 3,
  });
  assert.ok(out.length > 0);
  for (const c of out) {
    const dur = c.endMs - c.startMs;
    assert.ok(dur >= 15_000 && dur <= 45_000, `${dur}ms out of range`);
    assert.ok(c.score >= 0 && c.score <= 1);
    assert.equal(typeof c.title, "string");
    assert.ok(Array.isArray(c.hashtags));
  }
  // sorted by score, descending
  for (let i = 1; i < out.length; i++) assert.ok(out[i - 1].score >= out[i].score);
});

test("heuristic output flows through refineSuggestions to a capped, ordered set", async () => {
  const provider = new HeuristicAnalysisProvider();
  const opts = { minClipMs: 15_000, maxClipMs: 45_000, maxClips: 3 };
  const refined = refineSuggestions(await provider.suggestClips(TRANSCRIPT, opts), TRANSCRIPT, DURATION, {
    ...opts,
    maxTotalRatio: 0.5,
  });
  assert.ok(refined.length <= 3);
  for (let i = 1; i < refined.length; i++) {
    assert.ok(refined[i - 1].startMs < refined[i].startMs);
  }
});

test("heuristic provider returns [] for an empty transcript", async () => {
  const out = await new HeuristicAnalysisProvider().suggestClips([], {
    minClipMs: 1,
    maxClipMs: 2,
    maxClips: 1,
  });
  assert.deepEqual(out, []);
});
