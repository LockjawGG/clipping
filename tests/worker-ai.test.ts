import test from "node:test";
import assert from "node:assert/strict";

import { buildSuggestions, type WorkerInput } from "../src/lib/worker-ai/suggest.ts";
import type { AudioFeatures } from "../src/lib/audio/features.ts";
import type { ClipSuggestion } from "../src/lib/providers/types.ts";

const candidate = (over: Partial<ClipSuggestion> = {}): ClipSuggestion => ({
  startMs: 0,
  endMs: 5000,
  title: "A clip",
  hook: "wait for it",
  description: "",
  reason: "opens on a question",
  caption: "",
  socialTitle: "",
  hashtags: [],
  score: 0.5,
  ...over,
});

/** `n` windows of 250ms at a given loudness / flatness. */
const feat = (
  loudness: number[],
  flatness: number[] = [],
  silences: AudioFeatures["silences"] = [],
): AudioFeatures => ({
  version: 1,
  stepMs: 250,
  loudness,
  flatness: flatness.length ? flatness : loudness.map(() => 0.05),
  silences,
  durationMs: loudness.length * 250,
});

const run = (over: Partial<WorkerInput> = {}) =>
  buildSuggestions({ candidates: [], features: null, ...over });

test("with no audio pass, candidates still come through on the transcript alone", () => {
  const out = run({ candidates: [candidate({ score: 0.8 })] });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "HIGHLIGHT");
  // Audio is neutral (0.5), so 0.65*0.8 + 0.35*0.5 = 0.695.
  assert.ok(Math.abs(out[0].score - 0.695) < 1e-9);
  assert.equal(out[0].signals.transcript, 0.8);
  assert.equal(out[0].signals.energy, undefined, "no audio -> no audio signals claimed");
});

test("every suggestion explains itself", () => {
  const out = run({
    candidates: [candidate()],
    features: feat([...Array(20).fill(-30), ...Array(8).fill(-8)], [], [
      { startMs: 9000, endMs: 11000 },
    ]),
  });
  assert.ok(out.length > 0);
  for (const s of out) assert.ok(s.reason.trim().length > 5, `empty reason on ${s.kind}`);
});

test("audio energy re-ranks two candidates the transcript scored equally", () => {
  // Loud in the first half, quiet in the second.
  const features = feat([...Array(20).fill(-8), ...Array(20).fill(-34)]);
  const out = run({
    candidates: [
      candidate({ startMs: 0, endMs: 5000, title: "loud", score: 0.5 }),
      candidate({ startMs: 5000, endMs: 10000, title: "quiet", score: 0.5 }),
    ],
    features,
  });
  const loud = out.find((s) => s.payload?.title === "loud")!;
  const quiet = out.find((s) => s.payload?.title === "quiet")!;
  assert.ok(loud.score > quiet.score, `${loud.score} should beat ${quiet.score}`);
  assert.match(loud.reason, /top quarter/);
  assert.match(quiet.reason, /quieter than most/);
});

test("the transcript outweighs the audio, so a cough cannot beat a real moment", () => {
  const features = feat([...Array(20).fill(-34), ...Array(20).fill(-8)]);
  const out = run({
    candidates: [
      // Strong transcript, quiet delivery.
      candidate({ startMs: 0, endMs: 5000, title: "substance", score: 0.95 }),
      // Weak transcript, loud noise.
      candidate({ startMs: 5000, endMs: 10000, title: "noise", score: 0.15 }),
    ],
    features,
  });
  assert.equal(out.find((s) => s.score === Math.max(...out.map((x) => x.score)))!.payload?.title, "substance");
});

test("a window that is mostly silence is penalised however well it reads", () => {
  const features = feat(Array(40).fill(-20), [], [{ startMs: 0, endMs: 4000 }]);
  const out = run({ candidates: [candidate({ startMs: 0, endMs: 5000, score: 0.9 })], features });
  const highlight = out.find((s) => s.kind === "HIGHLIGHT")!;
  assert.match(highlight.reason, /80% silence/);
  assert.ok(highlight.signals.silenceRatio! > 0.7);
  // 0.65*0.9 = 0.585 from the transcript alone; the audio term is crushed.
  assert.ok(highlight.score < 0.65, `got ${highlight.score}`);
  // The same gap is also surfaced on its own as something to cut.
  assert.ok(out.some((s) => s.kind === "DEAD_AIR"));
});

test("a laugh inside a candidate boosts it and is not also reported separately", () => {
  // Quiet throughout, with a loud broadband burst at 3-4s.
  const loudness = [...Array(12).fill(-30), ...Array(4).fill(-10), ...Array(24).fill(-30)];
  const flatness = [...Array(12).fill(0.05), ...Array(4).fill(0.8), ...Array(24).fill(0.05)];
  const features = feat(loudness, flatness);

  const withCandidate = run({
    candidates: [candidate({ startMs: 2500, endMs: 5000, score: 0.5 })],
    features,
  });
  const highlight = withCandidate.find((s) => s.kind === "HIGHLIGHT")!;
  assert.match(highlight.reason, /laugh or crowd reaction/);
  assert.equal(
    withCandidate.filter((s) => s.kind === "REACTION").length,
    0,
    "already covered by the highlight",
  );

  // The same laugh with no candidate over it *is* worth surfacing.
  const alone = run({ candidates: [], features });
  assert.equal(alone.filter((s) => s.kind === "REACTION").length, 1);
});

test("dead air is suggested with the time it would save", () => {
  const features = feat(Array(40).fill(-20), [], [
    { startMs: 1000, endMs: 1400 }, // 400ms — too short to bother with
    { startMs: 4000, endMs: 6500 }, // 2.5s
  ]);
  const dead = run({ candidates: [], features }).filter((s) => s.kind === "DEAD_AIR");
  assert.equal(dead.length, 1);
  assert.deepEqual([dead[0].startMs, dead[0].endMs], [4000, 6500]);
  assert.equal(dead[0].signals.savedMs, 2500);
  assert.match(dead[0].reason, /2\.5s of silence/);
});

test("objectives switch whole categories off", () => {
  const features = feat(
    [...Array(12).fill(-30), ...Array(8).fill(-10)],
    [...Array(12).fill(0.05), ...Array(8).fill(0.8)],
    [{ startMs: 0, endMs: 2000 }],
  );
  const input = { candidates: [candidate()], features };

  const kinds = (o: WorkerInput["objectives"]) =>
    new Set(buildSuggestions({ ...input, objectives: o }).map((s) => s.kind));

  assert.ok(kinds({}).has("HIGHLIGHT"));
  assert.ok(!kinds({ highlights: false }).has("HIGHLIGHT"));
  assert.ok(!kinds({ reactions: false }).has("REACTION"));
  assert.ok(!kinds({ deadAir: false }).has("DEAD_AIR"));
  assert.equal(buildSuggestions({ ...input, objectives: { highlights: false, reactions: false, deadAir: false } }).length, 0);
});

test("results are ordered by time, because the panel is read against the recording", () => {
  const features = feat(Array(60).fill(-20), [], [{ startMs: 12000, endMs: 14000 }]);
  const out = run({
    candidates: [
      candidate({ startMs: 8000, endMs: 10000, score: 0.2 }),
      candidate({ startMs: 1000, endMs: 3000, score: 0.9 }),
    ],
    features,
  });
  const starts = out.map((s) => s.startMs);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
});

test("maxHighlights caps highlights only, keeping the best ones", () => {
  const candidates = Array.from({ length: 10 }, (_, i) =>
    candidate({ startMs: i * 1000, endMs: i * 1000 + 900, title: `c${i}`, score: i / 10 }),
  );
  const features = feat(Array(60).fill(-20), [], [{ startMs: 30000, endMs: 32000 }]);
  const out = buildSuggestions({ candidates, features, maxHighlights: 3 });
  const highlights = out.filter((s) => s.kind === "HIGHLIGHT");
  assert.equal(highlights.length, 3);
  // The three highest transcript scores survived.
  assert.deepEqual(
    highlights.map((h) => h.payload?.title).sort(),
    ["c7", "c8", "c9"],
  );
  // Dead air is not squeezed out by the cap.
  assert.equal(out.filter((s) => s.kind === "DEAD_AIR").length, 1);
});

test("an empty run is empty, not a crash", () => {
  assert.deepEqual(run(), []);
  assert.deepEqual(run({ features: feat([]) }), []);
});
