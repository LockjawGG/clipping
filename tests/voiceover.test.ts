import test from "node:test";
import assert from "node:assert/strict";
import { executableExists } from "../src/lib/providers/executable.ts";
import {
  getVoiceover,
  upsertVoiceover,
  type VoiceoverServiceDeps,
} from "../src/lib/api/voiceover.ts";

import {
  missingLines,
  overrunningLines,
  parseLines,
  placeLines,
  serializeLines,
  staleLines,
  type AnchorTiming,
  type VoiceLine,
} from "../src/lib/voiceover/sync.ts";
import { parseVoiceFile, wavDurationMs } from "../src/lib/tts/piper-local.ts";
import { buildVoiceoverMixArgs } from "../src/lib/ffmpeg/args.ts";

const line = (ref: string, durationMs: number, text = `line ${ref}`): VoiceLine => ({
  ref,
  text,
  durationMs,
  audioKey: `vo/${ref}.wav`,
});

const anchor = (ref: string, startMs: number, endMs: number): AnchorTiming => ({
  ref,
  startMs,
  endMs,
});

// ------------------------------------------------------------------ placement

test("a line is placed at its anchor's current position, not where it was made", () => {
  // This is the whole point: the clip moved, and the narration moved with it
  // without re-synthesizing anything.
  const lines = [line("a", 1000)];
  const before = placeLines(lines, [anchor("a", 5000, 7000)]);
  const after = placeLines(lines, [anchor("a", 20_000, 22_000)]);
  assert.equal(before[0].startMs, 5000);
  assert.equal(after[0].startMs, 20_000);
  assert.equal(after[0].tempo, 1, "no retiming was needed, so none was applied");
});

test("a line that fits its window is left completely untouched", () => {
  const placed = placeLines([line("a", 1500)], [anchor("a", 0, 2000)]);
  assert.equal(placed[0].tempo, 1);
  assert.equal(placed[0].playedMs, 1500);
  assert.equal(placed[0].overflowMs, 0);
});

test("a long line is sped up to fit rather than overlapping the next", () => {
  const lines = [line("a", 3000), line("b", 500)];
  const anchors = [anchor("a", 0, 2000), anchor("b", 2400, 3000)];
  const placed = placeLines(lines, anchors);
  // The window runs to the next line's start, not past it.
  assert.ok(placed[0].tempo > 1, `expected a speed-up, got ${placed[0].tempo}`);
  assert.ok(placed[0].startMs + placed[0].playedMs <= placed[1].startMs + 1);
});

test("speed-up is capped, and what still does not fit is reported", () => {
  // Three seconds of speech into a half-second gap cannot work.
  const placed = placeLines([line("a", 3000)], [anchor("a", 0, 500)], { maxTempo: 1.35 });
  assert.equal(placed[0].tempo, 1.35, "clamped, not stretched to unintelligible");
  assert.ok(placed[0].overflowMs > 0);
  assert.deepEqual(overrunningLines(placed), placed, "surfaced for the UI to warn about");
});

test("lines are never slowed down to fill a gap", () => {
  const placed = placeLines([line("a", 200)], [anchor("a", 0, 10_000)]);
  assert.equal(placed[0].tempo, 1);
  assert.equal(placed[0].overflowMs, 0);
});

test("a line may run past its own anchor into the gap that follows", () => {
  // Anchor is 0-1000 but nothing follows until 5000, so a 2s line is fine.
  const placed = placeLines([line("a", 2000)], [anchor("a", 0, 1000)], {
    slackMs: 4000,
    durationMs: 10_000,
  });
  assert.equal(placed[0].tempo, 1);
  assert.equal(placed[0].overflowMs, 0);
});

test("a line whose anchor was deleted is dropped, not relocated", () => {
  // Silently moving narration is worse than losing it: the user cannot see
  // that it moved, but they can see that it is gone.
  const placed = placeLines([line("a", 500), line("gone", 500)], [anchor("a", 0, 1000)]);
  assert.deepEqual(
    placed.map((p) => p.ref),
    ["a"],
  );
});

test("placement follows the anchors' order, not the stored order", () => {
  const lines = [line("c", 300), line("a", 300), line("b", 300)];
  const anchors = [anchor("a", 0, 500), anchor("b", 1000, 1500), anchor("c", 2000, 2500)];
  assert.deepEqual(
    placeLines(lines, anchors).map((p) => p.ref),
    ["a", "b", "c"],
  );
});

test("an empty voiceover places nothing", () => {
  assert.deepEqual(placeLines([], [anchor("a", 0, 1000)]), []);
  assert.deepEqual(placeLines([line("a", 100)], []), []);
});

// ------------------------------------------------------------------ staleness

test("only a real text change marks a line stale", () => {
  const lines = [line("a", 500, "Hello there"), line("b", 500, "Second line")];
  const current = new Map([
    ["a", "  hello   THERE "],
    ["b", "Something else entirely"],
  ]);
  assert.deepEqual(
    staleLines(lines, current).map((l) => l.ref),
    ["b"],
    "whitespace and case are not worth re-synthesizing over",
  );
});

test("missingLines reports what still needs synthesis", () => {
  const lines = [line("a", 500)];
  const current = new Map([
    ["a", "line a"],
    ["b", "line b"],
    ["c", "line c"],
  ]);
  assert.deepEqual(missingLines(lines, current), ["b", "c"]);
});

test("stored lines round-trip and reject junk", () => {
  const lines = [line("a", 500), line("b", 700)];
  const json = serializeLines(lines)!;
  assert.deepEqual(parseLines(json), lines);
  assert.equal(serializeLines([]), null);
  assert.deepEqual(parseLines(null), []);
  assert.deepEqual(parseLines("{ not json"), []);
  // A malformed entry is dropped, not allowed through to the mixer.
  assert.deepEqual(parseLines('{"version":1,"lines":[{"ref":"a"},{"ref":"b","text":"t","audioKey":"k","durationMs":1}]}'), [
    { ref: "b", text: "t", audioKey: "k", durationMs: 1 },
  ]);
});

// ------------------------------------------------------------------- provider

test("Piper voice filenames parse into language and label", () => {
  assert.deepEqual(parseVoiceFile("en_US-amy-medium.onnx"), {
    id: "en_US-amy-medium",
    language: "en-US",
    label: "amy (medium)",
  });
  assert.deepEqual(parseVoiceFile("es_ES-sharvard-high.onnx"), {
    id: "es_ES-sharvard-high",
    language: "es-ES",
    label: "sharvard (high)",
  });
  assert.equal(parseVoiceFile("en_US-amy-medium.onnx.json"), null, "config files are not voices");
  assert.equal(parseVoiceFile("readme.txt"), null);
});

test("wav duration is derived from byte length, header excluded", () => {
  // 1 second of 16-bit mono at 22050 Hz.
  assert.equal(wavDurationMs(44 + 22_050 * 2, 22_050), 1000);
  assert.equal(wavDurationMs(44, 22_050), 0, "header only is silence");
  assert.equal(wavDurationMs(0, 22_050), 0);
});

// --------------------------------------------------------------------- mixing

test("the mixer retimes, positions and ducks", () => {
  const args = buildVoiceoverMixArgs({
    inputPath: "/tmp/clip.mp4",
    outputPath: "/tmp/out.mp4",
    lines: [
      { path: "/tmp/l0.wav", startMs: 1000, tempo: 1, playedMs: 900 },
      { path: "/tmp/l1.wav", startMs: 4000, tempo: 1.25, playedMs: 1600 },
    ],
  });
  const fc = args[args.indexOf("-filter_complex") + 1];

  assert.match(fc, /\[1:a\]adelay=1000:all=1\[vo0\]/, "tempo 1 adds no atempo step");
  assert.match(fc, /\[2:a\]atempo=1\.25,adelay=4000:all=1\[vo1\]/);
  // Ducking covers both line windows.
  assert.match(fc, /between\(t,1,1\.9\)\+between\(t,4,5\.6\)/);
  // -12 dB is a gain of ~0.2512.
  assert.match(fc, /volume='if\([^']+,0\.2512,1\)':eval=frame\[bed\]/);
  assert.match(fc, /amix=inputs=3:duration=first:dropout_transition=0:normalize=0/);
  assert.deepEqual(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 2), ["-c:v", "copy"]);
});

test("ducking can be switched off", () => {
  const args = buildVoiceoverMixArgs({
    inputPath: "/tmp/clip.mp4",
    outputPath: "/tmp/out.mp4",
    lines: [{ path: "/tmp/l0.wav", startMs: 0, tempo: 1, playedMs: 500 }],
    duckDb: 0,
  });
  const fc = args[args.indexOf("-filter_complex") + 1];
  assert.match(fc, /\[0:a\]anull\[bed\]/);
  assert.ok(!fc.includes("volume='if("));
});

test("the mixer refuses a no-op pass", () => {
  assert.throws(
    () => buildVoiceoverMixArgs({ inputPath: "/tmp/a.mp4", outputPath: "/tmp/b.mp4", lines: [] }),
    /no voiceover lines/,
  );
});

test("a command on PATH counts as installed, not just one given as a path", () => {
  // Every local binary defaults to a bare name, because that is how a package
  // manager installs it. Checking that name as a filesystem path meant the
  // default configuration could never pass its own availability check.
  assert.equal(executableExists("node"), true, "the process running this test is on PATH");
  assert.equal(executableExists("definitely-not-a-real-binary-xyz"), false);
  assert.equal(executableExists(""), false);
});

test("a value that looks like a path is checked as a path", () => {
  // Writing a path is an explicit instruction to use that file, so it must not
  // fall back to a PATH lookup of the same name.
  assert.equal(executableExists("./package.json"), true);
  assert.equal(executableExists("./no-such-file-here.txt"), false);
});

// --- getVoiceover hands back playable lines, unplaced ----------------------

function previewDeps(over: Partial<Record<string, unknown>> = {}) {
  const clip = { id: "c1", videoId: "v1", startMs: 10_000, endMs: 26_000, video: { projectId: "p1" } };
  const lines = [
    { ref: "seg:0", text: "one", durationMs: 2_000, audioKey: "vo/a.wav" },
    { ref: "seg:1", text: "two", durationMs: 9_000, audioKey: "vo/b.wav" },
  ];
  const deps = {
    db: {
      clip: { findUnique: async () => clip },
      voiceover: {
        findFirst: async () => ({
          id: "vo1", clipId: "c1", sourceKind: "TRANSCRIPT", script: null, language: "en",
          voiceId: "", speed: 1, duckDb: -12, status: "COMPLETED", errorMessage: null,
          linesJson: JSON.stringify({ version: 1, lines }),
        }),
        create: async () => { throw new Error("unused"); },
        update: async () => { throw new Error("unused"); },
        delete: async () => { throw new Error("unused"); },
      },
      ...over,
    },
    storage: { createDownloadUrl: async (k: string) => `https://files/${k}` },
    assertProjectOwned: async () => {},
    enqueue: async () => "j1",
  } as unknown as VoiceoverServiceDeps;
  return deps;
}

test("every synthesized line comes back with something to play it from", async () => {
  const vo = await getVoiceover(previewDeps(), "c1");
  assert.ok(vo);
  assert.deepEqual(
    vo.lines.map((l) => [l.ref, l.durationMs, l.url]),
    [
      ["seg:0", 2_000, "https://files/vo/a.wav"],
      ["seg:1", 9_000, "https://files/vo/b.wav"],
    ],
  );
  assert.equal(vo.lineCount, 2);
});

test("the server does not place the lines", async () => {
  // Placement depends on the timeline and on which words are struck out, and
  // the editor holds edits the server has not been told about. Anchoring here
  // would describe a different clip from the one on screen, so the shape
  // deliberately carries no position at all.
  const vo = await getVoiceover(previewDeps(), "c1");
  for (const line of vo!.lines) {
    assert.ok(!("startMs" in line), `line ${line.ref} came back pre-placed`);
    assert.ok(!("tempo" in line), `line ${line.ref} came back with a tempo`);
  }
});

test("no synthesized audio means nothing for the preview to play", async () => {
  const deps = previewDeps({
    voiceover: {
      findFirst: async () => ({
        id: "vo1", clipId: "c1", sourceKind: "TRANSCRIPT", script: null, language: "en",
        voiceId: "", speed: 1, duckDb: 0, status: "QUEUED", errorMessage: null, linesJson: null,
      }),
      create: async () => { throw new Error("unused"); },
      update: async () => { throw new Error("unused"); },
      delete: async () => { throw new Error("unused"); },
    },
  });
  const vo = await getVoiceover(deps, "c1");
  assert.deepEqual(vo!.lines, []);
  assert.equal(vo!.lineCount, 0);
});

// --- the on/off switch ------------------------------------------------------

function toggleDeps() {
  const row = {
    id: "vo1", clipId: "c1", sourceKind: "TRANSCRIPT", script: null, language: "en",
    voiceId: "", speed: 1, duckDb: -12, enabled: true, status: "COMPLETED",
    errorMessage: null,
    linesJson: JSON.stringify({
      version: 1,
      lines: [{ ref: "seg:0", text: "one", durationMs: 2_000, audioKey: "vo/a.wav" }],
    }),
  };
  const queued: unknown[] = [];
  const updates: Array<Record<string, unknown>> = [];
  const deps = {
    db: {
      clip: { findUnique: async () => ({ id: "c1", videoId: "v1", startMs: 0, endMs: 9_000, video: { projectId: "p1" } }) },
      voiceover: {
        findFirst: async () => row,
        update: async ({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          return { ...row, ...data };
        },
        create: async () => { throw new Error("unused"); },
        delete: async () => { throw new Error("unused"); },
      },
    },
    storage: { createDownloadUrl: async (k: string) => `https://files/${k}` },
    assertProjectOwned: async () => {},
    enqueue: async (j: unknown) => { queued.push(j); return "j1"; },
  } as unknown as VoiceoverServiceDeps;
  return { deps, queued, updates };
}

test("switching the narration off does not re-synthesize it", async () => {
  const { deps, queued, updates } = toggleDeps();
  const vo = await upsertVoiceover(deps, "c1", { enabled: false });

  // The audio is untouched, so sending the clip back through Piper would be a
  // minute of waiting for nothing — and would leave the panel saying QUEUED.
  assert.deepEqual(queued, [], "no synthesis job");
  assert.deepEqual(updates, [{ enabled: false }], "status left alone");
  assert.equal(vo.enabled, false);
  assert.equal(vo.status, "COMPLETED");
  // The lines survive, so switching back on costs nothing.
  assert.equal(vo.lineCount, 1);
  assert.equal(vo.lines.length, 1);
});

test("changing what is spoken still re-synthesizes", async () => {
  const { deps, queued, updates } = toggleDeps();
  await upsertVoiceover(deps, "c1", { speed: 1.2 });
  assert.equal(queued.length, 1, "speed changes the audio, so it must be redone");
  assert.equal(updates[0].status, "QUEUED");
});

test("a toggle bundled with a real change is still a real change", async () => {
  const { deps, queued } = toggleDeps();
  await upsertVoiceover(deps, "c1", { enabled: true, voiceId: "other" });
  assert.equal(queued.length, 1);
});
