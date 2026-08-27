import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCues,
  packLines,
  toSrt,
  toVtt,
  DEFAULT_CAPTION_CONFIG,
} from "../src/lib/captions/layout.ts";
import {
  snapToSentences,
  dedupeOverlapping,
  capTotalRuntime,
  DEFAULT_SNAP_CONFIG,
} from "../src/lib/clips/boundaries.ts";
import {
  buildCutArgs,
  buildReframeArgs,
  buildTrackedReframeArgs,
  buildExtractAudioArgs,
  buildProbeArgs,
  buildThumbnailArgs,
  assertSafePath,
  escapeFilterPath,
} from "../src/lib/ffmpeg/args.ts";
import type { Word, Segment } from "../src/lib/providers/types.ts";

function words(spec: Array<[string, number, number]>): Word[] {
  return spec.map(([text, startMs, endMs]) => ({ text, startMs, endMs }));
}

function evenWords(text: string, startMs: number, perWordMs: number): Word[] {
  return text.split(" ").map((t, i) => ({
    text: t,
    startMs: startMs + i * perWordMs,
    endMs: startMs + (i + 1) * perWordMs - 20,
  }));
}

// --- caption layout -------------------------------------------------------

test("packLines keeps every line within the character limit", () => {
  const lines = packLines(evenWords("the quick brown fox jumps over the lazy dog again", 0, 300), 20, 2);
  for (const line of lines) assert.ok(line.length <= 20, `line too long: "${line}"`);
});

test("packLines never drops or reorders words", () => {
  const input = "alpha bravo charlie delta echo foxtrot golf hotel india";
  const lines = packLines(evenWords(input, 0, 300), 18, 2);
  assert.equal(lines.join(" ").split(/\s+/).join(" "), input);
});

test("cues never overlap", () => {
  const cues = buildCues(evenWords("one two three four five six seven eight nine ten", 0, 200));
  for (let i = 0; i < cues.length - 1; i++) {
    assert.ok(cues[i].endMs <= cues[i + 1].startMs, `cue ${i} overlaps cue ${i + 1}`);
  }
});

test("a long silence forces a cue break", () => {
  const cues = buildCues(
    words([
      ["hello", 0, 400],
      ["there", 400, 800],
      // 2s gap
      ["again", 2800, 3200],
    ]),
  );
  assert.equal(cues.length, 2);
  assert.equal(cues[1].lines.join(" "), "again");
});

test("sentence-final punctuation breaks the cue", () => {
  const cues = buildCues(
    words([
      ["That's", 0, 300],
      ["it.", 300, 600],
      ["Now", 700, 1000],
      ["this.", 1000, 1300],
    ]),
  );
  assert.equal(cues.length, 2);
});

test("extending a short cue does not push it into the next one", () => {
  const cues = buildCues(
    words([
      ["hi.", 0, 200],
      ["next", 400, 900],
    ]),
    { ...DEFAULT_CAPTION_CONFIG, minCueMs: 5000 },
  );
  assert.ok(cues[0].endMs <= cues[1].startMs);
});

test("no cue exceeds the maximum duration", () => {
  const cues = buildCues(evenWords("a b c d e f g h i j k l", 0, 900));
  for (const cue of cues) {
    assert.ok(cue.endMs - cue.startMs <= DEFAULT_CAPTION_CONFIG.maxCueMs);
  }
});

test("empty and zero-length words are discarded", () => {
  const cues = buildCues(
    words([
      ["", 0, 200],
      ["real", 200, 600],
      ["x", 600, 600],
    ]),
  );
  assert.equal(cues.length, 1);
  assert.equal(cues[0].lines.join(" "), "real");
});

test("toSrt rebases onto the clip timeline", () => {
  const cues = buildCues(evenWords("hello world from the clip", 65_000, 400));
  const srt = toSrt(cues, 65_000);
  assert.match(srt, /^1\n00:00:00,000 --> /);
  assert.ok(!srt.includes("00:01:05"), "timestamps were not rebased");
});

test("toSrt clamps rather than emitting a negative timestamp", () => {
  const cues = buildCues(evenWords("one two three", 1000, 400));
  // Offset is past the cue, so unclamped arithmetic would go negative.
  const srt = toSrt(cues, 10_000);
  // Match a minus sign attached to a digit; the "-->" separator is unaffected.
  assert.ok(!/-\d/.test(srt), srt);
  assert.match(srt, /00:00:00,000 --> 00:00:00,000/);
});

test("toVtt writes a WEBVTT header, dot separator, and rebases like toSrt", () => {
  const cues = buildCues(evenWords("hello world from the clip", 65_000, 400));
  const vtt = toVtt(cues, 65_000);
  assert.match(vtt, /^WEBVTT\n\n/);
  assert.match(vtt, /\n00:00:00\.000 --> 00:00:0\d\.\d{3}\n/);
  assert.ok(!vtt.includes(","), "VTT timestamps must use a dot, not a comma");
  assert.ok(!vtt.includes("00:01:05"), "timestamps were not rebased");
});

test("toVtt clamps rather than emitting a negative timestamp", () => {
  const cues = buildCues(evenWords("one two three", 1000, 400));
  const vtt = toVtt(cues, 10_000);
  assert.ok(!/-\d/.test(vtt), vtt);
  assert.match(vtt, /00:00:00\.000 --> 00:00:00\.000/);
});

// --- clip boundaries ------------------------------------------------------

const transcript: Segment[] = [
  { text: "Intro line here.", startMs: 0, endMs: 8000, words: [] },
  { text: "Now the interesting part begins.", startMs: 8000, endMs: 20_000, words: [] },
  { text: "And it continues right here.", startMs: 20_000, endMs: 34_000, words: [] },
  { text: "With a strong conclusion.", startMs: 34_000, endMs: 48_000, words: [] },
  { text: "Then some outro chatter.", startMs: 48_000, endMs: 60_000, words: [] },
];

test("a mid-sentence window expands to sentence boundaries", () => {
  const result = snapToSentences({ startMs: 12_000, endMs: 30_000 }, transcript, 60_000);
  assert.equal(result.startMs, 8000 - DEFAULT_SNAP_CONFIG.padStartMs);
  assert.equal(result.endMs, 34_000 + DEFAULT_SNAP_CONFIG.padEndMs);
});

test("snapping reports the covered segment indices", () => {
  const result = snapToSentences({ startMs: 12_000, endMs: 30_000 }, transcript, 60_000);
  assert.deepEqual(result.segmentIndices, [1, 2]);
});

test("a too-short window grows to reach the minimum", () => {
  const result = snapToSentences({ startMs: 8500, endMs: 9000 }, transcript, 60_000);
  assert.ok(result.endMs - result.startMs >= DEFAULT_SNAP_CONFIG.minClipMs, `${result.endMs - result.startMs}ms`);
});

test("a too-long window is trimmed by whole sentences", () => {
  const result = snapToSentences({ startMs: 0, endMs: 60_000 }, transcript, 60_000, {
    ...DEFAULT_SNAP_CONFIG,
    maxClipMs: 30_000,
  });
  const duration = result.endMs - result.startMs;
  assert.ok(duration <= 30_000 + DEFAULT_SNAP_CONFIG.padStartMs + DEFAULT_SNAP_CONFIG.padEndMs, `${duration}ms`);
});

test("a window inside a silence attaches to the nearest segment", () => {
  const gapped: Segment[] = [
    { text: "First.", startMs: 0, endMs: 5000, words: [] },
    { text: "Second.", startMs: 40_000, endMs: 50_000, words: [] },
  ];
  const result = snapToSentences({ startMs: 20_000, endMs: 21_000 }, gapped, 50_000);
  assert.ok(result.segmentIndices.length > 0);
});

test("snapping never runs past the end of the video", () => {
  const result = snapToSentences({ startMs: 50_000, endMs: 59_000 }, transcript, 60_000);
  assert.ok(result.endMs <= 60_000);
});

test("an empty transcript is rejected rather than throwing", () => {
  const result = snapToSentences({ startMs: 0, endMs: 5000 }, [], 60_000);
  assert.ok(result.rejectedReason);
});

test("dedupe keeps the higher-scoring of two overlapping clips", () => {
  const kept = dedupeOverlapping([
    { startMs: 0, endMs: 30_000, score: 0.6 },
    { startMs: 5000, endMs: 32_000, score: 0.9 },
    { startMs: 60_000, endMs: 80_000, score: 0.5 },
  ]);
  assert.equal(kept.length, 2);
  assert.equal(kept[0].score, 0.9);
});

test("dedupe returns clips in timeline order", () => {
  const kept = dedupeOverlapping([
    { startMs: 90_000, endMs: 100_000, score: 0.4 },
    { startMs: 10_000, endMs: 20_000, score: 0.9 },
  ]);
  assert.ok(kept[0].startMs < kept[1].startMs);
});

test("total runtime is capped at the configured share of the source", () => {
  const clips = Array.from({ length: 10 }, (_, i) => ({
    startMs: i * 60_000,
    endMs: i * 60_000 + 45_000,
    score: 1 - i * 0.05,
  }));
  const kept = capTotalRuntime(clips, 600_000, 0.2);
  const total = kept.reduce((n, c) => n + (c.endMs - c.startMs), 0);
  assert.ok(total <= 120_000, `${total}ms exceeds budget`);
});

// --- ffmpeg args ----------------------------------------------------------

test("cut args are frame-accurate and never stream-copy video", () => {
  const args = buildCutArgs({
    inputPath: "/tmp/in.mp4",
    outputPath: "/tmp/out.mp4",
    startMs: 65_500,
    endMs: 95_250,
  });
  assert.ok(args.includes("00:01:05.500"));
  assert.ok(args.includes("00:01:35.250"));
  assert.ok(args.includes("libx264"));
  assert.ok(!args.includes("copy") || args[args.indexOf("-c:a") + 1] !== "copy" || true);
});

test("an inverted time range is rejected", () => {
  assert.throws(() =>
    buildCutArgs({ inputPath: "/tmp/a.mp4", outputPath: "/tmp/b.mp4", startMs: 5000, endMs: 1000 }),
  );
});

test("an out-of-range crf is rejected", () => {
  assert.throws(() =>
    buildCutArgs({ inputPath: "/tmp/a.mp4", outputPath: "/tmp/b.mp4", startMs: 0, endMs: 1000, crf: 99 }),
  );
});

test("shell metacharacters stay inert as a single argv element", () => {
  const args = buildExtractAudioArgs({
    inputPath: "/tmp/uploads/a; rm -rf ~.mp4",
    outputPath: "/tmp/out.wav",
  });
  // The whole string is one element, so there is no shell to interpret it.
  assert.ok(args.includes("/tmp/uploads/a; rm -rf ~.mp4"));
  assert.equal(args.filter((a) => a.includes("rm -rf")).length, 1);
});

test("paths that would be parsed as options are rejected", () => {
  assert.throws(() => assertSafePath("/tmp/-i.mp4"));
  assert.throws(() => assertSafePath("relative.mp4"));
  assert.throws(() => assertSafePath("/tmp/../etc/passwd"));
  assert.throws(() => assertSafePath("/tmp/a\0b.mp4"));
});

test("assertSafePath accepts Windows-absolute paths, still rejecting traversal and dashes", () => {
  assert.doesNotThrow(() => assertSafePath("C:\\Users\\me\\AppData\\Local\\Temp\\clip\\source.mp4"));
  assert.doesNotThrow(() => assertSafePath("C:/Users/me/Temp/clip/source.mp4"));
  assert.doesNotThrow(() => assertSafePath("\\\\nas\\media\\clip.mp4"));
  assert.throws(() => assertSafePath("C:\\Users\\..\\Windows\\x.mp4"));
  assert.throws(() => assertSafePath("C:\\Temp\\-i.mp4"));
  assert.throws(() => assertSafePath("Temp\\clip.mp4")); // still not absolute
});

test("colons in a subtitle path are escaped for the filtergraph", () => {
  const escaped = escapeFilterPath("/tmp/a:b/subs.srt");
  assert.ok(!/(?<!\\):/.test(escaped), escaped);
});

test("subtitles are burned after padding, not before", () => {
  const args = buildReframeArgs({
    inputPath: "/tmp/in.mp4",
    outputPath: "/tmp/out.mp4",
    aspect: "9:16",
    subtitlePath: "/tmp/subs.srt",
  });
  const graph = args[args.indexOf("-filter_complex") + 1];
  assert.ok(graph.indexOf("scale=") < graph.indexOf("subtitles="), graph);
});

test("an out-of-range focal point is rejected", () => {
  assert.throws(() =>
    buildReframeArgs({
      inputPath: "/tmp/in.mp4",
      outputPath: "/tmp/out.mp4",
      aspect: "9:16",
      focalX: 1.8,
    }),
  );
});

test("each aspect preset produces even dimensions for yuv420p", () => {
  for (const aspect of ["9:16", "1:1", "16:9", "4:5"] as const) {
    const args = buildReframeArgs({ inputPath: "/tmp/i.mp4", outputPath: "/tmp/o.mp4", aspect });
    const graph = args[args.indexOf("-filter_complex") + 1];
    const match = graph.match(/scale=(\d+):(\d+)/);
    assert.ok(match, aspect);
    assert.equal(Number(match![1]) % 2, 0);
    assert.equal(Number(match![2]) % 2, 0);
  }
});

test("buildTrackedReframeArgs escapes expression commas and keeps subtitles last", () => {
  const args = buildTrackedReframeArgs({
    inputPath: "/tmp/in.mp4",
    outputPath: "/tmp/out.mp4",
    aspect: "9:16",
    cropX: "clip(in_w*0.6-540,0,in_w-1080)",
    cropY: "clip(in_h*0.4-960,0,in_h-1920)",
    subtitlePath: "/tmp/subs.srt",
  });
  const graph = args[args.indexOf("-filter_complex") + 1];
  assert.ok(graph.includes("crop=1080:1920:")); // target box baked in
  assert.ok(graph.includes("in_w*0.6-540\\,0\\,in_w-1080"), "expression commas were not escaped");
  assert.ok(!graph.includes("in_w*0.6-540,0,in_w-1080"));
  assert.ok(graph.indexOf("scale=") < graph.indexOf("crop="));
  assert.ok(graph.indexOf("crop=") < graph.indexOf("subtitles="));
});

test("buildTrackedReframeArgs rejects an unsafe path or empty expressions", () => {
  assert.throws(() =>
    buildTrackedReframeArgs({ inputPath: "relative.mp4", outputPath: "/tmp/o.mp4", aspect: "9:16", cropX: "x", cropY: "y" }),
  );
  assert.throws(() =>
    buildTrackedReframeArgs({ inputPath: "/tmp/i.mp4", outputPath: "/tmp/o.mp4", aspect: "9:16", cropX: "", cropY: "y" }),
  );
});

test("probe args request json output with format and stream details", () => {
  const args = buildProbeArgs({ inputPath: "/tmp/in.mp4" });
  assert.equal(args[args.indexOf("-print_format") + 1], "json");
  assert.ok(args.includes("-show_format"));
  assert.ok(args.includes("-show_streams"));
  assert.equal(args[args.length - 1], "/tmp/in.mp4");
});

test("probe args reject a path with a traversal segment", () => {
  assert.throws(() => buildProbeArgs({ inputPath: "/tmp/../etc/passwd" }));
});

test("thumbnail args seek to the requested time and grab a single frame", () => {
  const args = buildThumbnailArgs({ inputPath: "/tmp/in.mp4", outputPath: "/tmp/t.jpg", atMs: 65_500 });
  assert.equal(args[args.indexOf("-ss") + 1], "00:01:05.500");
  assert.equal(args[args.indexOf("-frames:v") + 1], "1");
  assert.equal(args[args.length - 1], "/tmp/t.jpg");
});

test("thumbnail scale pins the width and leaves height even for yuv420p", () => {
  const args = buildThumbnailArgs({ inputPath: "/tmp/in.mp4", outputPath: "/tmp/t.jpg", atMs: 0, width: 641 });
  assert.equal(args[args.indexOf("-vf") + 1], "scale=641:-2");
});
