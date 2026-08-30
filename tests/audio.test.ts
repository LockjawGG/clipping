import test from "node:test";
import assert from "node:assert/strict";

import {
  LUFS_FLOOR,
  parseAudioFeatures,
  parseStoredFeatures,
  serializeFeatures,
  type AudioFeatures,
} from "../src/lib/audio/features.ts";
import {
  energyScale,
  findAudioMoments,
  findDeadAir,
  loudnessPercentile,
  windowStats,
} from "../src/lib/audio/energy.ts";
import { buildAudioFeatureArgs } from "../src/lib/ffmpeg/args.ts";

/** A real excerpt of ffmpeg's `ametadata=mode=print` output. */
const DUMP = `frame:0    pts:0       pts_time:0
lavfi.r128.M=-120.691
lavfi.r128.S=-120.691
lavfi.aspectralstats.1.centroid=386.246
lavfi.aspectralstats.1.flatness=0.0388158
lavfi.aspectralstats.1.crest=73.4323
frame:1    pts:4000    pts_time:0.25
lavfi.r128.M=-21.768
lavfi.aspectralstats.1.flatness=0.003
frame:2    pts:8000    pts_time:0.5
lavfi.r128.M=-13.187
lavfi.aspectralstats.1.flatness=0.8346
lavfi.silence_start=0.5
frame:3    pts:12000   pts_time:0.75
lavfi.r128.M=-120.691
lavfi.aspectralstats.1.flatness=0
lavfi.silence_end=1.25
lavfi.silence_duration=0.75
`;

const feat = (loudness: number[], flatness: number[] = [], silences: AudioFeatures["silences"] = []): AudioFeatures => ({
  version: 1,
  stepMs: 250,
  loudness,
  flatness: flatness.length ? flatness : loudness.map(() => 0),
  silences,
  durationMs: loudness.length * 250,
});

test("parseAudioFeatures reads loudness, flatness and silence from a real dump", () => {
  const f = parseAudioFeatures(DUMP);
  assert.equal(f.stepMs, 250);
  assert.deepEqual(f.loudness, [LUFS_FLOOR, -21.768, -13.187, LUFS_FLOOR]);
  assert.deepEqual(f.flatness, [0.0388158, 0.003, 0.8346, 0]);
  assert.deepEqual(f.silences, [{ startMs: 500, endMs: 1250 }]);
  assert.equal(f.durationMs, 1000);
});

test("digital silence is floored rather than carried as -120 LUFS", () => {
  // -120.691 would dominate every average and make relative scoring useless.
  const f = parseAudioFeatures(DUMP);
  assert.ok(f.loudness.every((n) => n >= LUFS_FLOOR));
});

test("parseAudioFeatures ignores unknown keys and junk", () => {
  const f = parseAudioFeatures(`frame:0    pts:0       pts_time:0
lavfi.r128.M=-20
lavfi.aspectralstats.1.kurtosis=66.9
not a key value line
lavfi.r128.M=nonsense
`);
  assert.deepEqual(f.loudness, [-20], "the unparseable value did not clobber the good one");
  assert.deepEqual(f.flatness, [0]);
});

test("an empty dump is valid, not an error", () => {
  // A video with no audio stream produces nothing; the job must still complete.
  const f = parseAudioFeatures("");
  assert.deepEqual(f.loudness, []);
  assert.deepEqual(f.silences, []);
  assert.equal(f.durationMs, 250);
});

test("a silence still open at EOF runs to the end of the audio", () => {
  const f = parseAudioFeatures(`frame:0    pts:0       pts_time:0
lavfi.r128.M=-20
frame:1    pts:4000    pts_time:0.25
lavfi.r128.M=-70
lavfi.silence_start=0.25
`);
  // The last window starts at 250ms and covers 250-500, so that is the end.
  assert.deepEqual(f.silences, [{ startMs: 250, endMs: 500 }]);
});

test("a silence_end with no start counts from zero", () => {
  const f = parseAudioFeatures(`frame:0    pts:0       pts_time:0
lavfi.r128.M=-70
lavfi.silence_end=0.5
`);
  assert.deepEqual(f.silences, [{ startMs: 0, endMs: 500 }]);
});

test("features round-trip through storage and reject junk", () => {
  const f = parseAudioFeatures(DUMP);
  const back = parseStoredFeatures(serializeFeatures(f));
  assert.ok(back);
  assert.equal(back.loudness.length, f.loudness.length);
  assert.equal(back.silences.length, 1);
  assert.equal(parseStoredFeatures(null), null);
  assert.equal(parseStoredFeatures("{ not json"), null);
  assert.equal(parseStoredFeatures('{"version":2}'), null, "a future version is not assumed compatible");
});

test("serialization rounds hard — a 30 minute clip is 7200 windows", () => {
  const f = feat([-21.76812345, -13.18734], [0.03881586, 0.8346123]);
  const json = serializeFeatures(f);
  assert.match(json, /-21\.8/);
  assert.match(json, /0\.039/);
  assert.ok(json.length < 200, `compact, got ${json.length} chars`);
});

test("percentiles ignore silence so a quiet clip is not scaled by its gaps", () => {
  const f = feat([LUFS_FLOOR, LUFS_FLOOR, -30, -20, -10]);
  // Only the three voiced windows count.
  assert.equal(loudnessPercentile(f, 0.5), -20);
  assert.equal(loudnessPercentile(f, 0), -30);
  assert.equal(loudnessPercentile(f, 1), -10);
  // All-silent is defined, not NaN.
  assert.equal(loudnessPercentile(feat([LUFS_FLOOR]), 0.5), LUFS_FLOOR);
});

test("energy is scored against the clip's own spread, not an absolute level", () => {
  // The same shape at two very different mastering levels must score alike.
  const quiet = feat([-40, -35, -30, -25, -20]);
  const loud = feat([-25, -20, -15, -10, -5]);
  const q = energyScale(quiet);
  const l = energyScale(loud);
  assert.ok(Math.abs(q(-40) - l(-25)) < 0.01, "the floor scores the same");
  assert.ok(Math.abs(q(-20) - l(-5)) < 0.01, "the peak scores the same");
});

test("a flat recording degrades to a neutral score rather than dividing by zero", () => {
  const scale = energyScale(feat([-20, -20, -20]));
  assert.equal(scale(-20), 0.5);
});

test("windowStats aggregates the right windows and measures silence overlap", () => {
  const f = feat([-30, -20, -10, -40], [0, 0.2, 0.8, 0], [{ startMs: 750, endMs: 1000 }]);
  const s = windowStats(f, 0, 1000);
  assert.equal(s.peakLufs, -10);
  assert.ok(Math.abs(s.meanLufs - -25) < 1e-9);
  assert.ok(Math.abs(s.flatness - 0.25) < 1e-9);
  assert.equal(s.silenceRatio, 0.25);
  // A sub-window reads only its own slice.
  assert.equal(windowStats(f, 500, 750).peakLufs, -10);
});

test("findAudioMoments separates loud speech from broadband laughter", () => {
  // Twelve quiet windows, then a loud harmonic burst, then a broadband one.
  const loudness = [
    ...Array(12).fill(-30),
    -8, -8, -8, -8,
    -12, -12, -12, -12,
  ];
  const flatness = [
    ...Array(12).fill(0.05),
    0.04, 0.04, 0.04, 0.04,
    0.7, 0.7, 0.7, 0.7,
  ];
  const moments = findAudioMoments(feat(loudness, flatness));

  const energy = moments.filter((m) => m.kind === "energy");
  const laughter = moments.filter((m) => m.kind === "laughter");
  assert.ok(energy.length >= 1, "the loud burst was found");
  assert.equal(energy[0].startMs, 3000, "at the 12th window");
  assert.equal(laughter.length, 1, "only the broadband run counts as laughter");
  assert.equal(laughter[0].startMs, 4000);
  // Every moment explains itself — suggestions are never unexplained.
  for (const m of moments) assert.ok(m.reason.length > 10, m.reason);
});

test("broadband hiss below conversational level is not laughter", () => {
  // High flatness but quiet: tape hiss, air conditioning, not a crowd.
  const f = feat([...Array(12).fill(-20), -60, -60, -60, -60], [
    ...Array(12).fill(0.05),
    0.9, 0.9, 0.9, 0.9,
  ]);
  assert.equal(findAudioMoments(f).filter((m) => m.kind === "laughter").length, 0);
});

test("brief blips are ignored and neighbouring runs merge", () => {
  const loudness = [...Array(12).fill(-30), -8, -30, -8, -8, -8, -8];
  const f = feat(loudness);
  // One 250ms window on its own is under the 600ms floor; the run after the
  // single-window gap merges rather than reporting as two moments.
  const energy = findAudioMoments(f).filter((m) => m.kind === "energy");
  assert.equal(energy.length, 1);
  assert.equal(energy[0].startMs, 3000);
});

test("no features means no moments, not a crash", () => {
  assert.deepEqual(findAudioMoments(feat([])), []);
  assert.deepEqual(findDeadAir(feat([])), []);
});

test("findDeadAir applies a minimum length", () => {
  const f = feat([-20], [], [
    { startMs: 0, endMs: 500 },
    { startMs: 2000, endMs: 3200 },
  ]);
  const found = findDeadAir(f, 800);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0], { startMs: 2000, endMs: 3200, durationMs: 1200 });
});

test("buildAudioFeatureArgs thins the dump and orders the filters correctly", () => {
  const args = buildAudioFeatureArgs({
    inputPath: "/tmp/audio.wav",
    metadataPath: "/tmp/out.txt",
    stepMs: 250,
  });
  const af = args[args.indexOf("-af") + 1];
  // asetnsamples must come *after* the analyzers: upstream it gets re-framed by
  // ebur128 and silently has no effect.
  assert.ok(af.indexOf("ebur128") < af.indexOf("asetnsamples"));
  assert.ok(af.indexOf("aspectralstats") < af.indexOf("asetnsamples"));
  assert.ok(af.indexOf("asetnsamples") < af.indexOf("ametadata"));
  // 250ms at the WAV's 16kHz.
  assert.match(af, /asetnsamples=n=4000/);
  assert.match(af, /silencedetect=n=-45dB/);
  // Analysis only — no output file is written.
  assert.deepEqual(args.slice(-3), ["-f", "null", "-"]);
});

test("buildAudioFeatureArgs rejects an unusable window", () => {
  assert.throws(
    () =>
      buildAudioFeatureArgs({
        inputPath: "/tmp/a.wav",
        metadataPath: "/tmp/o.txt",
        stepMs: 5,
      }),
    /bad stepMs/,
  );
});
