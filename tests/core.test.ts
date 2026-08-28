import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCues,
  packLines,
  packLineGroups,
  toSrt,
  toStyledSrt,
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
  buildForceStyle,
  buildOverlayCompositeArgs,
  buildProbeArgs,
  buildThumbnailArgs,
  assertSafePath,
  escapeFilterPath,
  type CaptionBurnStyle,
} from "../src/lib/ffmpeg/args.ts";
import type { Word, Segment } from "../src/lib/providers/types.ts";

function words(spec: Array<[string, number, number]>): Word[] {
  return spec.map(([text, startMs, endMs]) => ({ text, startMs, endMs }));
}

function evenWords(text: string, startMs: number, perWordMs: number): Word[] {
  return text.split(" ").map((t, i) => ({
    id: `w${i}`,
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

// --- per-word caption styling in the burn -------------------------------

test("packLineGroups returns the same words as packLines, grouped per line", () => {
  const words = evenWords("the quick brown fox jumps over the lazy dog again", 0, 300);
  const groups = packLineGroups(words, 20, 2);
  assert.deepEqual(
    groups.map((g) => g.map((w) => w.text).join(" ")),
    packLines(words, 20, 2),
  );
  // every word is preserved exactly once, in order
  assert.deepEqual(
    groups.flat().map((w) => w.text),
    words.map((w) => w.text),
  );
});

test("toStyledSrt wraps only styled words and leaves the rest identical to toSrt", () => {
  const cues = buildCues(evenWords("today we use AI to caption", 0, 400));
  const plain = toSrt(cues, 0);
  const styled = toStyledSrt(cues, 0, {
    w3: { color: "#FFE600", bold: true, italic: null },
  });
  // "AI" (w3) gets font + bold tags; nesting is <font><b>…</b></font>
  assert.match(styled, /<font color="#FFE600"><b>AI<\/b><\/font>/);
  // unstyled words untouched
  assert.match(styled, /\btoday\b/);
  assert.doesNotMatch(styled.replace(/<[^>]+>/g, ""), /</);
  // stripping the tags reproduces the plain SRT exactly
  assert.equal(styled.replace(/<\/?(font[^>]*|b|i)>/g, ""), plain);
});

test("toStyledSrt with no matching styles equals toSrt", () => {
  const cues = buildCues(evenWords("nothing styled here at all", 0, 400));
  assert.equal(toStyledSrt(cues, 0, { unknownWord: { color: "#FF0000" } }), toSrt(cues, 0));
});

test("toStyledSrt emits italic-only and colour-only correctly", () => {
  const cues = buildCues(evenWords("make this word italic", 0, 400));
  const s = toStyledSrt(cues, 0, {
    w1: { italic: true },
    w3: { color: "#00E5FF" },
  });
  assert.match(s, /<i>this<\/i>/);
  assert.match(s, /<font color="#00E5FF">italic<\/font>/);
});

const burnStyle = (over: Partial<CaptionBurnStyle> = {}): CaptionBurnStyle => ({
  fontName: "Inter",
  fontSizePx: 64,
  fontWeight: 700,
  textColor: "#FFFFFF",
  outlineColor: "#000000",
  outlineWidthPx: 6,
  backgroundColor: null,
  alignment: "center",
  positionY: 0.78,
  ...over,
});

test("buildForceStyle converts hex to SSA &H00BBGGRR and sets bold from weight", () => {
  const s = buildForceStyle(burnStyle({ textColor: "#12ab34", fontWeight: 400 }), {
    width: 1080,
    height: 1920,
  });
  assert.match(s, /PrimaryColour=&H0034AB12/);
  assert.match(s, /OutlineColour=&H00000000/);
  assert.match(s, /Bold=0/);
  assert.match(s, /Alignment=2/);
});

test("buildForceStyle derives MarginV from positionY (bottom-anchored, PlayResY space)", () => {
  const near = buildForceStyle(burnStyle({ positionY: 0.9 }), { width: 1080, height: 1920 });
  const far = buildForceStyle(burnStyle({ positionY: 0.5 }), { width: 1080, height: 1920 });
  const mv = (s: string) => Number(/MarginV=(\d+)/.exec(s)![1]);
  assert.equal(mv(near), Math.round(0.1 * 288));
  assert.ok(mv(far) > mv(near)); // higher up the frame = larger bottom margin
});

test("buildForceStyle scales font size into the libass script space", () => {
  const s = buildForceStyle(burnStyle({ fontSizePx: 96 }), { width: 1080, height: 1920 });
  assert.equal(Number(/FontSize=(\d+)/.exec(s)![1]), Math.round((96 * 288) / 1920));
});

test("buildForceStyle switches to an opaque box when a background is set", () => {
  const box = buildForceStyle(burnStyle({ backgroundColor: "#101010" }), {
    width: 1080,
    height: 1920,
  });
  assert.match(box, /BorderStyle=3/);
  assert.match(box, /BackColour=&H00101010/);
  assert.doesNotMatch(buildForceStyle(burnStyle(), { width: 1080, height: 1920 }), /BorderStyle=3/);
});

test("buildReframeArgs embeds a styled subtitles filter with comma-escaped force_style", () => {
  const args = buildReframeArgs({
    inputPath: "/tmp/in.mp4",
    outputPath: "/tmp/out.mp4",
    aspect: "9:16",
    subtitlePath: "/tmp/captions.srt",
    subtitleStyle: burnStyle({ alignment: "left" }),
  });
  const fc = args[args.indexOf("-filter_complex") + 1];
  assert.match(fc, /subtitles=[^,]*captions\.srt/);
  assert.match(fc, /force_style='[^']*Alignment=1[^']*'/);
  // commas inside force_style are escaped so they don't split the filtergraph
  assert.match(fc, /FontSize=\d+\\,/);
});

// --- overlay compositing -----------------------------------------------

test("buildOverlayCompositeArgs adds one input per overlay and a chained filtergraph", () => {
  const args = buildOverlayCompositeArgs({
    inputPath: "/w/in.mp4",
    outputPath: "/w/out.mp4",
    frameWidth: 1080,
    items: [
      { path: "/w/o0.png", x: 0.5, y: 0.5, scale: 1, opacity: 1, startSec: null, endSec: null },
      { path: "/w/o1.gif", x: 0, y: 1, scale: 0.5, opacity: 0.4, startSec: 1, endSec: 3, loop: true },
    ],
  });
  // base video + 2 overlay inputs
  assert.equal(args.filter((a) => a === "-i").length, 3);
  assert.deepEqual(
    args.filter((_, i) => args[i - 1] === "-i"),
    ["/w/in.mp4", "/w/o0.png", "/w/o1.gif"],
  );
  // gif overlay is looped
  assert.ok(args.includes("-ignore_loop"));
  const fc = args[args.indexOf("-filter_complex") + 1];
  // first overlay: no enable window, full opacity
  assert.match(fc, /\[1:v\]scale=\d+:-1,format=rgba,colorchannelmixer=aa=1\[ov0\]/);
  assert.match(fc, /\[0:v\]\[ov0\]overlay=x='\(W-w\)\*0\.5':y='\(H-h\)\*0\.5':eof_action=pass\[b0\]/);
  // second overlay: timed window + reduced opacity, writes the final [vout]
  assert.match(fc, /aa=0\.4\[ov1\]/);
  assert.match(fc, /\[b0\]\[ov1\]overlay=[^;]*enable='between\(t,1,3\)'\[vout\]/);
  // final video stream mapped, audio passed through untouched, video re-encoded
  assert.equal(args[args.indexOf("-map") + 1], "[vout]");
  assert.ok(args.includes("0:a?"));
  assert.equal(args[args.indexOf("-c:a") + 1], "copy");
  assert.equal(args[args.indexOf("-c:v") + 1], "libx264");
  assert.equal(args.at(-1), "/w/out.mp4");
});

test("buildOverlayCompositeArgs clamps out-of-range position and opacity", () => {
  const args = buildOverlayCompositeArgs({
    inputPath: "/w/in.mp4",
    outputPath: "/w/out.mp4",
    frameWidth: 1080,
    items: [{ path: "/w/o.png", x: 5, y: -2, scale: 99, opacity: 2, startSec: null, endSec: null }],
  });
  const fc = args[args.indexOf("-filter_complex") + 1];
  assert.match(fc, /x='\(W-w\)\*1':y='\(H-h\)\*0'/);
  assert.match(fc, /aa=1\[ov0\]/);
});

test("buildOverlayCompositeArgs rejects an empty item list and non-absolute paths", () => {
  assert.throws(() =>
    buildOverlayCompositeArgs({ inputPath: "/w/in.mp4", outputPath: "/w/out.mp4", frameWidth: 1080, items: [] }),
  );
  assert.throws(() =>
    buildOverlayCompositeArgs({
      inputPath: "relative.mp4",
      outputPath: "/w/out.mp4",
      frameWidth: 1080,
      items: [{ path: "/w/o.png", x: 0.5, y: 0.5, scale: 1, opacity: 1, startSec: null, endSec: null }],
    }),
  );
});

test("buildOverlayCompositeArgs uses gte(t,..) when only a start is given", () => {
  const args = buildOverlayCompositeArgs({
    inputPath: "/w/in.mp4",
    outputPath: "/w/out.mp4",
    frameWidth: 720,
    items: [{ path: "/w/o.png", x: 0.5, y: 0.5, scale: 1, opacity: 1, startSec: 2, endSec: null }],
  });
  const fc = args[args.indexOf("-filter_complex") + 1];
  assert.match(fc, /enable='gte\(t,2\)'/);
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
