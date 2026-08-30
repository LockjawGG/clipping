import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JobContext, JobRecord } from "../src/lib/jobs/types.ts";
import type {
  CutOptions,
  MediaInfo,
  OverlayCompositeOptions,
  ReframeOptions,
} from "../src/lib/ffmpeg/run.ts";
import type { PipelineDeps, RenderTarget } from "../src/lib/pipeline/deps.ts";
import { renderHandler } from "../src/lib/pipeline/handlers.ts";
import type { Segment } from "../src/lib/providers/types.ts";

const PROBE: MediaInfo = {
  durationMs: 30_000,
  width: 1080,
  height: 1920,
  fps: 30,
  videoCodec: "h264",
  audioCodec: "aac",
  hasAudio: true,
  audioChannels: 2,
  sampleRate: 48_000,
  sizeBytes: 2_000_000,
};

const WORDS: Segment[] = [
  {
    startMs: 0,
    endMs: 40_000,
    text: "one two three four",
    words: [
      { id: "wa", text: "one", startMs: 10_500, endMs: 10_900 },
      { id: "wb", text: "two", startMs: 11_000, endMs: 11_400 },
      { id: "wc", text: "three", startMs: 11_500, endMs: 11_900 },
      { id: "wd", text: "four", startMs: 39_000, endMs: 39_500 }, // outside a 10s..38s clip
    ],
  },
];

interface Spy {
  began: string[];
  completed: Array<{ id: string; outputKey: string }>;
  failed: Array<{ id: string; message: string }>;
  cuts: CutOptions[];
  concats: Array<{ pieces: string[]; reencode?: boolean }>;
  layered: Array<{ layers: Array<{ path: string; startSec: number }>; width: number; height: number }>;
  reframes: ReframeOptions[];
  trackedReframes: number;
  trackedTracks: Array<Array<{ atMs: number; x: number; y: number }>>;
  zoomReframes: Array<{ aspect: string; fps: number; sampleCount: number; maxScale: number }>;
  probed: string[];
  puts: string[];
  captioned: Array<{
    preset: string;
    videoPath: string;
    cueCount: number;
    cueText: string;
    durationMs: number;
    textOverlayCount: number;
    imageOverlays: Array<{ path: string; animationJson: string | null }>;
  }>;
  composed: OverlayCompositeOptions[];
  censors: Array<{ input: string; mode: string; spans: Array<{ startSec: number; endSec: number }> }>;
  voMixes: Array<{ input: string; duckDb?: number; lines: Array<{ startMs: number; tempo: number }> }>;
  evicted: string[];
}

function makeDeps(target: RenderTarget | null, over: Partial<PipelineDeps> = {}) {
  const tempDir = (over.tempDir as string | undefined) ?? "/tmp/render-test";
  const spy: Spy = {
    began: [],
    completed: [],
    failed: [],
    cuts: [],
    concats: [],
    layered: [],
    reframes: [],
    trackedReframes: 0,
    trackedTracks: [],
    zoomReframes: [],
    probed: [],
    puts: [],
    captioned: [],
    composed: [],
    censors: [],
    voMixes: [],
    evicted: [],
  };
  const deps = {
    tempDir,
    ffmpeg: {
      probe: async (p: string) => {
        spy.probed.push(p);
        return PROBE;
      },
      extractAudio: async () => {},
      cut: async (_i: string, _o: string, opts: CutOptions) => {
        spy.cuts.push(opts);
      },
      concat: async (pieces: readonly string[], _o: string, opts: { reencode?: boolean }) => {
        spy.concats.push({ pieces: [...pieces], reencode: opts?.reencode });
      },
      layerVideo: async (
        _i: string,
        _o: string,
        opts: { layers: Array<{ path: string; startSec: number }>; width: number; height: number },
      ) => {
        spy.layered.push({ layers: opts.layers, width: opts.width, height: opts.height });
      },
      reframe: async (_i: string, _o: string, opts: ReframeOptions) => {
        spy.reframes.push(opts);
      },
      reframeTracked: async (
        _i: string,
        _o: string,
        opts: { track: Array<{ atMs: number; x: number; y: number }> },
      ) => {
        spy.trackedReframes++;
        spy.trackedTracks.push(opts.track);
      },
      reframeZoom: async (
        _i: string,
        _o: string,
        opts: { aspect: string; fps: number; samples: Array<{ scale: number }> },
      ) => {
        spy.zoomReframes.push({
          aspect: opts.aspect,
          fps: opts.fps,
          sampleCount: opts.samples.length,
          maxScale: Math.max(...opts.samples.map((s) => s.scale)),
        });
      },
      censorAudio: async (
        i: string,
        _o: string,
        opts: { spans: Array<{ startSec: number; endSec: number }>; mode: string },
      ) => {
        spy.censors.push({ input: i, mode: opts.mode, spans: opts.spans });
      },
      mixVoiceover: async (
        i: string,
        _o: string,
        opts: { lines: Array<{ startMs: number; tempo: number }>; duckDb?: number },
      ) => {
        spy.voMixes.push({ input: i, duckDb: opts.duckDb, lines: opts.lines });
      },
      thumbnail: async () => {},
      composeOverlays: async (_i: string, _o: string, opts: OverlayCompositeOptions) => {
        spy.composed.push(opts);
      },
    },
    storage: {
      name: "fake",
      getToFile: async () => {},
      putFile: async (key: string) => {
        spy.puts.push(key);
      },
      createUploadUrl: async () => "",
      createDownloadUrl: async () => "",
      delete: async () => {},
      exists: async () => true,
    },
    source: {
      localPath: (videoId: string) => `${tempDir}/videos/${videoId}/source`,
      ensureLocal: async (videoId: string) => `${tempDir}/videos/${videoId}/source`,
      evict: async (videoId: string) => {
        spy.evicted.push(videoId);
      },
    },
    transcription: { name: "fake", transcribe: async () => ({ provider: "x", language: "en", segments: [] }) },
    analysis: { name: "fake", suggestClips: async () => [] },
    videos: {
      get: async () => null,
      applyProbe: async () => {},
      setStatus: async () => {},
      setError: async () => {},
    },
    transcripts: {
      save: async () => ({ segmentCount: 0 }),
      loadSegments: async () => WORDS,
    },
    clips: { replaceSuggested: async () => 0 },
    thumbnails: {
      target: async () => null,
      targetsForVideo: async () => [],
      setKey: async () => {},
      videoPosterTarget: async () => null,
      setVideoKey: async () => {},
    },
    faces: { name: "none", detectTrack: async () => [] },
    captions: {
      renderCaptioned: async (input: {
        preset: string;
        videoPath: string;
        cues: unknown[];
        durationMs: number;
        textOverlays?: unknown[];
        imageOverlays?: Array<{ path: string; animationJson: string | null }>;
      }) => {
        spy.captioned.push({
          preset: input.preset,
          videoPath: input.videoPath,
          cueCount: input.cues.length,
          cueText: JSON.stringify(input.cues),
          durationMs: input.durationMs,
          textOverlayCount: input.textOverlays?.length ?? 0,
          imageOverlays: input.imageOverlays ?? [],
        });
      },
    },
    renders: {
      loadTarget: async () => target,
      begin: async (id: string) => {
        spy.began.push(id);
      },
      complete: async (id: string, r: { outputKey: string }) => {
        spy.completed.push({ id, outputKey: r.outputKey });
      },
      fail: async (id: string, message: string) => {
        spy.failed.push({ id, message });
      },
    },
    queue: { enqueue: async () => "job-1" },
    ...over,
  } as unknown as PipelineDeps;
  return { deps, spy };
}

function ctx(deps: PipelineDeps, payload: unknown): JobContext<PipelineDeps> {
  const job: JobRecord = {
    id: "j1",
    videoId: "vid1",
    kind: "RENDER",
    status: "PROCESSING",
    attempts: 1,
    maxAttempts: 3,
    progress: 0,
    payload,
    runAfter: new Date(),
  };
  return { job, deps, signal: new AbortController().signal, setProgress: async () => {} };
}

function target(over: Partial<RenderTarget> = {}): RenderTarget {
  return {
    clipId: "clip1",
    videoId: "vid1",
    sourceKey: "videos/vid1/source.mp4",
    startMs: 10_000,
    endMs: 38_000,
    aspectRatio: "VERTICAL_9_16",
    focalX: 0.5,
    focalY: 0.4,
    focusTrackJson: null,
    removedWordIds: [],
    voiceover: null,
    sequence: null,
    censor: {
      enabled: false,
      sensitivity: "MEDIUM",
      captionMode: "FULL",
      audioEnabled: true,
      audioExemptWordIds: [],
      audioForceWordIds: [],
      wordOverridesJson: null,
      audioMode: "BEEP",
      replacement: null,
      allowList: [],
      denyList: [],
      exemptWordIds: [],
      forceWordIds: [],
    },
    quality: "P1080",
    burnCaptions: false,
    captionAnimation: "NONE",
    captionStyle: null,
    textStyle: null,
    wordRules: [],
    overlays: [],
    textOverlays: [],
    wordStyles: {},
    ...over,
  };
}

test("RENDER cuts, reframes to the aspect preset, probes, and uploads the mp4", async () => {
  const { deps, spy } = makeDeps(target());
  const result = await renderHandler(ctx(deps, { renderId: "r1" }));

  assert.deepEqual(spy.began, ["r1"]);
  assert.equal(spy.cuts.length, 1);
  assert.deepEqual(spy.cuts[0], { startMs: 10_000, endMs: 38_000, crf: 20 });
  assert.equal(spy.reframes.length, 1);
  assert.equal(spy.reframes[0].aspect, "9:16");
  assert.equal(spy.reframes[0].subtitlePath, undefined);
  assert.equal(spy.puts[0], "renders/r1/output.mp4");
  assert.deepEqual(spy.completed, [{ id: "r1", outputKey: "renders/r1/output.mp4" }]);
  assert.deepEqual(result, { outputKey: "renders/r1/output.mp4", durationMs: 30_000 });
});

test("a 16:9 clip with no captions skips the reframe pass", async () => {
  const { deps, spy } = makeDeps(target({ aspectRatio: "LANDSCAPE_16_9" }));
  await renderHandler(ctx(deps, { renderId: "r2" }));
  assert.equal(spy.cuts.length, 1);
  assert.equal(spy.reframes.length, 0);
  assert.equal(spy.puts[0], "renders/r2/output.mp4");
});

test("quality maps to the cut crf", async () => {
  const { deps, spy } = makeDeps(target({ quality: "P720" }));
  await renderHandler(ctx(deps, { renderId: "r3" }));
  assert.equal(spy.cuts[0].crf, 24);
});

test("clip overlays trigger a composite pass with clip-relative seconds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "render-ov-"));
  try {
    const { deps, spy } = makeDeps(
      target({
        overlays: [
          { storageKey: "assets/image/a.png", animated: false, x: 0.5, y: 0.2, scale: 1, rotation: 0, opacity: 0.8, startMs: 2000, endMs: 6000, animationJson: null },
          { storageKey: "assets/gif/b.gif", animated: true, x: 0.1, y: 0.9, scale: 0.5, rotation: 0, opacity: 1, startMs: null, endMs: null, animationJson: null },
        ],
      }),
      { tempDir: dir } as Partial<PipelineDeps>,
    );
    await renderHandler(ctx(deps, { renderId: "r-ov" }));

    assert.equal(spy.composed.length, 1);
    const c = spy.composed[0];
    assert.equal(c.frameWidth, 1080); // from the probe
    assert.equal(c.items.length, 2);
    assert.deepEqual(
      c.items.map((i) => [i.startSec, i.endSec, i.loop]),
      [
        [2, 6, false],
        [null, null, true],
      ],
    );
    assert.equal(spy.puts[0], "renders/r-ov/output.mp4");
    assert.equal(spy.captioned.length, 0, "static layers never wake Remotion");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a layer with motion is composited by Remotion, static ones stay on ffmpeg", async () => {
  const dir = await mkdtemp(join(tmpdir(), "render-ovmix-"));
  try {
    const { deps, spy } = makeDeps(
      target({
        overlays: [
          // static -> the cheap ffmpeg overlay filter
          { storageKey: "assets/image/a.png", animated: false, x: 0.5, y: 0.2, scale: 1, rotation: 0, opacity: 1, startMs: null, endMs: null, animationJson: null },
          // animated -> promoted, because `overlay` has no per-frame scale
          { storageKey: "assets/image/b.png", animated: false, x: 0.3, y: 0.7, scale: 1, rotation: 15, opacity: 1, startMs: 0, endMs: 4000, animationJson: '{"loop":"orbit"}' },
        ],
      }),
      { tempDir: dir } as Partial<PipelineDeps>,
    );
    await renderHandler(ctx(deps, { renderId: "r-ovmix" }));

    // One of each — the split is by animation, not by asset kind.
    assert.equal(spy.composed.length, 1, "ffmpeg still runs for the static layer");
    assert.equal(spy.composed[0].items.length, 1);
    assert.equal(spy.captioned.length, 1, "Remotion runs for the moving layer");
    assert.equal(spy.captioned[0].imageOverlays.length, 1);
    assert.equal(spy.captioned[0].imageOverlays[0].animationJson, '{"loop":"orbit"}');
    // Its bytes must be on disk before Remotion starts.
    assert.match(spy.captioned[0].imageOverlays[0].path, /moving-0\.png$/);
    assert.equal(spy.captioned[0].cueCount, 0, "no captions on this clip");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const CENSOR_WORDS: Segment[] = [
  {
    startMs: 0,
    endMs: 40_000,
    text: "well shit that worked",
    words: [
      { id: "c1", text: "well", startMs: 11_000, endMs: 11_300 },
      { id: "c2", text: "shit", startMs: 12_000, endMs: 12_400 },
      { id: "c3", text: "that", startMs: 13_000, endMs: 13_300 },
      { id: "c4", text: "worked", startMs: 14_000, endMs: 14_400 },
    ],
  },
];

const censorOn = {
  enabled: true,
  sensitivity: "MEDIUM" as const,
  captionMode: "FULL" as const,
  audioEnabled: true,
  audioExemptWordIds: [],
  audioForceWordIds: [],
  wordOverridesJson: null,
  audioMode: "BEEP" as const,
  replacement: null,
  allowList: [],
  denyList: [],
  exemptWordIds: [],
  forceWordIds: [],
};

const withTranscript = (segments: Segment[]) =>
  ({
    transcripts: { save: async () => ({ segmentCount: 0 }), loadSegments: async () => segments },
  }) as unknown as Partial<PipelineDeps>;

test("censoring bleeps the cut clip before anything else touches it", async () => {
  const { deps, spy } = makeDeps(target({ censor: censorOn }), withTranscript(CENSOR_WORDS));
  await renderHandler(ctx(deps, { renderId: "r-cen" }));

  assert.equal(spy.censors.length, 1);
  assert.equal(spy.censors[0].mode, "BEEP");
  // Runs on the cut, so every later pass can keep -c:a copy.
  assert.match(spy.censors[0].input, /cut\.mp4$/);
  // One span, rebased onto the clip's own timeline (the clip starts at 10s)
  // and padded 60ms either side.
  assert.equal(spy.censors[0].spans.length, 1);
  assert.ok(Math.abs(spy.censors[0].spans[0].startSec - 1.94) < 1e-9);
  assert.ok(Math.abs(spy.censors[0].spans[0].endSec - 2.46) < 1e-9);
});

test("a clean transcript runs no censor pass at all", async () => {
  const { deps, spy } = makeDeps(
    target({ censor: censorOn }),
    withTranscript([
      {
        startMs: 0,
        endMs: 40_000,
        text: "all clean here",
        words: [
          { id: "d1", text: "all", startMs: 11_000, endMs: 11_200 },
          { id: "d2", text: "clean", startMs: 12_000, endMs: 12_200 },
        ],
      },
    ]),
  );
  await renderHandler(ctx(deps, { renderId: "r-clean" }));
  assert.equal(spy.censors.length, 0, "nothing detected -> no transcode");
});

test("censoring off leaves the audio untouched even with profanity present", async () => {
  const { deps, spy } = makeDeps(target(), withTranscript(CENSOR_WORDS));
  await renderHandler(ctx(deps, { renderId: "r-off" }));
  assert.equal(spy.censors.length, 0);
});

test("captions are masked for the same words the audio bleeped", async () => {
  const { deps, spy } = makeDeps(
    target({ censor: censorOn, burnCaptions: true, captionAnimation: "POP" }),
    withTranscript(CENSOR_WORDS),
  );
  await renderHandler(ctx(deps, { renderId: "r-mask" }));

  assert.equal(spy.censors.length, 1, "audio still bleeped");
  assert.equal(spy.captioned.length, 1, "an animated preset routes to Remotion");
  const text = spy.captioned[0].cueText;
  assert.ok(text.includes("****"), `expected a masked word, got ${text}`);
  assert.ok(!text.includes("shit"), "the raw word must never reach the renderer");
  assert.ok(text.includes("worked"), "innocent words are untouched");
});

test("audio censoring off still masks the captions, but plays the speech", async () => {
  const { deps, spy } = makeDeps(
    target({
      censor: { ...censorOn, audioEnabled: false },
      burnCaptions: true,
      captionAnimation: "POP",
    }),
    withTranscript(CENSOR_WORDS),
  );
  await renderHandler(ctx(deps, { renderId: "r-noaudio" }));

  // The two halves of censoring are independent: this is the "show s*** over
  // audible speech" case, which is a normal editorial choice rather than a
  // half-configured clip.
  assert.equal(spy.censors.length, 0, "no bleep pass runs");
  const text = spy.captioned[0].cueText;
  assert.ok(text.includes("****"), `caption still masked, got ${text}`);
  assert.ok(!text.includes("shit"), "the raw word must never reach the renderer");
});

test("audio censoring off does not suppress a hand-picked word's mask", async () => {
  const { deps, spy } = makeDeps(
    target({
      censor: { ...censorOn, enabled: false, audioEnabled: false, forceWordIds: ["c2"] },
      burnCaptions: true,
      captionAnimation: "POP",
    }),
    withTranscript(CENSOR_WORDS),
  );
  await renderHandler(ctx(deps, { renderId: "r-noaudio2" }));

  assert.equal(spy.censors.length, 0);
  assert.ok(spy.captioned[0].cueText.includes("*"), "the hand-picked word is still masked");
});

test("one occurrence can be bleeped while another is only masked", async () => {
  const segs: Segment[] = [
    {
      startMs: 0,
      endMs: 40_000,
      text: "shit and shit",
      words: [
        { id: "b1", text: "shit", startMs: 12_000, endMs: 12_400 },
        { id: "b2", text: "and", startMs: 13_000, endMs: 13_300 },
        { id: "b3", text: "shit", startMs: 14_000, endMs: 14_400 },
      ],
    },
  ];
  const { deps, spy } = makeDeps(
    target({
      censor: { ...censorOn, audioExemptWordIds: ["b1"] },
      burnCaptions: true,
      captionAnimation: "POP",
    }),
    withTranscript(segs),
  );
  await renderHandler(ctx(deps, { renderId: "r-peraudio" }));

  assert.equal(spy.censors[0].spans.length, 1, "only the un-exempted one is bleeped");
  // Clip starts at 10s: the second "shit" lands at 4.0s, padded to 3.94.
  assert.ok(Math.abs(spy.censors[0].spans[0].startSec - 3.94) < 1e-9);
  // Both are still masked — the audio override does not touch the captions.
  const text = spy.captioned[0].cueText;
  assert.ok(!text.includes("shit"), `no raw word may survive, got ${text}`);
});

test("a word can be bleeped while the clip-wide audio switch is off", async () => {
  const { deps, spy } = makeDeps(
    target({
      censor: { ...censorOn, audioEnabled: false, audioForceWordIds: ["c2"] },
    }),
    withTranscript(CENSOR_WORDS),
  );
  await renderHandler(ctx(deps, { renderId: "r-forceaudio" }));

  assert.equal(spy.censors.length, 1, "the forced word still runs a bleep pass");
  assert.equal(spy.censors[0].spans.length, 1);
});

test("adjacent spans are not merged across a bleep exemption", async () => {
  // Two censored words back to back, one kept audible. Merging happens after
  // filtering, so the bleep must not swallow the neighbour.
  const segs: Segment[] = [
    {
      startMs: 0,
      endMs: 40_000,
      text: "shit shit",
      words: [
        { id: "m1", text: "shit", startMs: 12_000, endMs: 12_400 },
        { id: "m2", text: "shit", startMs: 12_420, endMs: 12_800 },
      ],
    },
  ];
  const { deps, spy } = makeDeps(
    target({ censor: { ...censorOn, audioExemptWordIds: ["m1"] } }),
    withTranscript(segs),
  );
  await renderHandler(ctx(deps, { renderId: "r-nomerge" }));

  assert.equal(spy.censors[0].spans.length, 1);
  // Starts at the *second* word (2.42s - 60ms pad), not the first.
  assert.ok(
    Math.abs(spy.censors[0].spans[0].startSec - 2.36) < 1e-9,
    `expected the kept word to stay audible, got ${spy.censors[0].spans[0].startSec}`,
  );
});

test("a word can carry its own caption mask, unlike its neighbours", async () => {
  const segs: Segment[] = [
    {
      startMs: 0,
      endMs: 40_000,
      text: "shit and shit",
      words: [
        { id: "k1", text: "shit", startMs: 12_000, endMs: 12_400 },
        { id: "k2", text: "and", startMs: 13_000, endMs: 13_300 },
        { id: "k3", text: "shit", startMs: 14_000, endMs: 14_400 },
      ],
    },
  ];
  const { deps, spy } = makeDeps(
    target({
      censor: {
        ...censorOn,
        captionMode: "FULL",
        wordOverridesJson: JSON.stringify({
          k3: { captionMode: "CUSTOM", replacement: "[REDACTED]" },
        }),
      },
      burnCaptions: true,
      captionAnimation: "POP",
    }),
    withTranscript(segs),
  );
  await renderHandler(ctx(deps, { renderId: "r-permask" }));

  const text = spy.captioned[0].cueText;
  assert.ok(text.includes("****"), `the clip default still applies, got ${text}`);
  assert.ok(text.includes("[REDACTED]"), `the per-word mask applies, got ${text}`);
  assert.ok(!text.includes("shit"), "no raw word survives either way");
});

test("censoring works with captions off — the words only drive the bleep", async () => {
  const { deps, spy } = makeDeps(
    target({ censor: censorOn, burnCaptions: false }),
    withTranscript(CENSOR_WORDS),
  );
  await renderHandler(ctx(deps, { renderId: "r-nocap" }));
  assert.equal(spy.censors.length, 1);
  assert.equal(spy.captioned.length, 0, "no caption pass was triggered");
});

test("a voiceover is mixed onto the cut, after censoring and before the reframe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "render-vo-"));
  try {
    const { deps, spy } = makeDeps(
      target({
        voiceover: {
          duckDb: -9,
          linesJson: JSON.stringify({
            version: 1,
            lines: [
              { ref: "seg:0", text: "narration", durationMs: 800, audioKey: "vo/a.wav" },
            ],
          }),
        },
      }),
      {
        tempDir: dir,
        transcripts: {
          save: async () => ({ segmentCount: 0 }),
          loadSegments: async () => [
            {
              startMs: 0,
              endMs: 40_000,
              text: "hello",
              words: [{ id: "w1", text: "hello", startMs: 12_000, endMs: 12_500 }],
            },
          ],
        },
      } as unknown as Partial<PipelineDeps>,
    );
    await renderHandler(ctx(deps, { renderId: "r-vo" }));

    assert.equal(spy.voMixes.length, 1);
    assert.equal(spy.voMixes[0].duckDb, -9, "the clip's own ducking level is used");
    // The segment starts at 0ms absolute; the clip starts at 10s, so the line
    // is placed at 0 on the clip's own timeline.
    assert.equal(spy.voMixes[0].lines[0].startMs, 0);
    // 800ms into a 28s window needs no speed-up.
    assert.equal(spy.voMixes[0].lines[0].tempo, 1);
    // Mixed onto the cut (nothing was censored here), and the reframe then
    // reads the narrated file.
    assert.match(spy.voMixes[0].input, /cut\.mp4$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a clip with no voiceover runs no mix pass", async () => {
  const { deps, spy } = makeDeps(target());
  await renderHandler(ctx(deps, { renderId: "r-novo" }));
  assert.equal(spy.voMixes.length, 0);
});

test("voiceover lines whose anchor is gone are dropped rather than misplaced", async () => {
  const dir = await mkdtemp(join(tmpdir(), "render-vo2-"));
  try {
    const { deps, spy } = makeDeps(
      target({
        voiceover: {
          duckDb: -12,
          linesJson: JSON.stringify({
            version: 1,
            lines: [{ ref: "seg:99", text: "orphan", durationMs: 500, audioKey: "vo/x.wav" }],
          }),
        },
      }),
      { tempDir: dir } as unknown as Partial<PipelineDeps>,
    );
    await renderHandler(ctx(deps, { renderId: "r-vo3" }));
    // Nothing placed -> no mix at all, rather than narration at the wrong time.
    assert.equal(spy.voMixes.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a per-occurrence exemption reaches the bleep, not just the UI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "render-cen2-"));
  try {
    // Two "shit"s in range; only the second should be bleeped.
    const segs: Segment[] = [
      {
        startMs: 0,
        endMs: 40_000,
        text: "shit and shit",
        words: [
          { id: "s1", text: "shit", startMs: 12_000, endMs: 12_400 },
          { id: "s2", text: "and", startMs: 13_000, endMs: 13_300 },
          { id: "s3", text: "shit", startMs: 14_000, endMs: 14_400 },
        ],
      },
    ];
    const { deps, spy } = makeDeps(
      target({ censor: { ...censorOn, exemptWordIds: ["s1"] } }),
      { tempDir: dir, ...withTranscript(segs) } as unknown as Partial<PipelineDeps>,
    );
    await renderHandler(ctx(deps, { renderId: "r-cen2" }));

    assert.equal(spy.censors.length, 1);
    assert.equal(spy.censors[0].spans.length, 1, "only the un-exempted one is bleeped");
    // Clip starts at 10s, so the second "shit" lands at 4.0s with 60ms padding.
    assert.ok(Math.abs(spy.censors[0].spans[0].startSec - 3.94) < 1e-9);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a hand-picked word is bleeped even with detection switched off", async () => {
  const dir = await mkdtemp(join(tmpdir(), "render-cen4-"));
  try {
    const segs: Segment[] = [
      {
        startMs: 0,
        endMs: 40_000,
        text: "shit happens here",
        words: [
          { id: "q1", text: "shit", startMs: 12_000, endMs: 12_400 },
          { id: "q2", text: "happens", startMs: 13_000, endMs: 13_400 },
        ],
      },
    ];
    const { deps, spy } = makeDeps(
      // Detection off, but one word ticked by hand.
      target({ censor: { ...censorOn, enabled: false, forceWordIds: ["q2"] } }),
      { tempDir: dir, ...withTranscript(segs) } as unknown as Partial<PipelineDeps>,
    );
    await renderHandler(ctx(deps, { renderId: "r-cen4" }));

    assert.equal(spy.censors.length, 1, "the pass still runs");
    assert.equal(spy.censors[0].spans.length, 1, "only the hand-picked word");
    // "happens" starts at 13s; the clip starts at 10s, minus 60ms padding.
    assert.ok(Math.abs(spy.censors[0].spans[0].startSec - 2.94) < 1e-9);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("detection off with nothing marked runs no censor pass at all", async () => {
  const { deps, spy } = makeDeps(
    target({ censor: { ...censorOn, enabled: false } }),
    withTranscript(CENSOR_WORDS),
  );
  await renderHandler(ctx(deps, { renderId: "r-cen5" }));
  assert.equal(spy.censors.length, 0);
});

test("a per-occurrence force-censor bleeps a word the lexicon ignores", async () => {
  const dir = await mkdtemp(join(tmpdir(), "render-cen3-"));
  try {
    const segs: Segment[] = [
      {
        startMs: 0,
        endMs: 40_000,
        text: "perfectly ordinary words",
        words: [
          { id: "p1", text: "perfectly", startMs: 12_000, endMs: 12_400 },
          { id: "p2", text: "ordinary", startMs: 13_000, endMs: 13_400 },
        ],
      },
    ];
    const { deps, spy } = makeDeps(
      target({ censor: { ...censorOn, forceWordIds: ["p2"] } }),
      { tempDir: dir, ...withTranscript(segs) } as unknown as Partial<PipelineDeps>,
    );
    await renderHandler(ctx(deps, { renderId: "r-cen3" }));

    assert.equal(spy.censors.length, 1);
    assert.equal(spy.censors[0].spans.length, 1);
    assert.ok(Math.abs(spy.censors[0].spans[0].startSec - 2.94) < 1e-9, "the second word");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("no overlays -> no composite pass", async () => {
  const { deps, spy } = makeDeps(target());
  await renderHandler(ctx(deps, { renderId: "r-noov" }));
  assert.equal(spy.composed.length, 0);
});

test("static captions (NONE): an SRT is burned during reframe, Remotion is not used", async () => {
  const dir = await mkdtemp(join(tmpdir(), "render-caps-"));
  try {
    const { deps, spy } = makeDeps(target({ burnCaptions: true }), { tempDir: dir } as Partial<PipelineDeps>);
    await renderHandler(ctx(deps, { renderId: "r4" }));

    assert.equal(spy.reframes.length, 1);
    const srtPath = spy.reframes[0].subtitlePath!;
    assert.ok(srtPath.endsWith("captions.srt"));
    const srt = await readFile(srtPath, "utf8");
    assert.match(srt, /00:00:00,\d{3} --> /); // rebased onto the clip timeline
    assert.match(srt, /one two three/i);
    assert.doesNotMatch(srt, /\bfour\b/i); // the 39s word is outside the 10..38s clip
    assert.equal(spy.captioned.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("per-word styles are burned as inline SRT tags on the static path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "render-ws-"));
  try {
    const { deps, spy } = makeDeps(
      target({
        burnCaptions: true,
        wordStyles: { wa: { color: "#FFE600", bold: true, italic: null } },
      }),
      { tempDir: dir } as Partial<PipelineDeps>,
    );
    await renderHandler(ctx(deps, { renderId: "r-ws" }));

    const srt = await readFile(spy.reframes[0].subtitlePath!, "utf8");
    assert.match(srt, /<font color="#FFE600"><b>one<\/b><\/font>/);
    assert.match(srt, /\btwo three\b/); // unstyled words stay plain
    assert.equal(spy.captioned.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("animated captions: Remotion composites over the reframed clip, no SRT burn", async () => {
  const { deps, spy } = makeDeps(
    target({ burnCaptions: true, captionAnimation: "POP" }),
  );
  await renderHandler(ctx(deps, { renderId: "r6" }));

  assert.equal(spy.reframes.length, 1);
  assert.equal(spy.reframes[0].subtitlePath, undefined); // not burned by ffmpeg
  assert.equal(spy.captioned.length, 1);
  assert.equal(spy.captioned[0].preset, "pop");
  assert.ok(spy.captioned[0].cueCount > 0);
  assert.ok(spy.captioned[0].videoPath.endsWith("reframed.mp4"));
  assert.equal(spy.puts[0], "renders/r6/output.mp4");
  assert.deepEqual(spy.completed, [{ id: "r6", outputKey: "renders/r6/output.mp4" }]);
});

test("a text overlay drives the Remotion composite pass even with no captions", async () => {
  const { deps, spy } = makeDeps(
    target({
      aspectRatio: "LANDSCAPE_16_9", // no reframe, no captions
      textOverlays: [
        {
          text: "BREAKING",
          x: 0.5,
          y: 0.2,
          scale: 1.4,
          rotation: 0,
          opacity: 1,
          startMs: 1000,
          endMs: 5000,
          styleJson: '{"fill":{"kind":"linear-gradient","stops":["#a","#b"]}}',
          animationJson: '{"intro":"slide-up"}',
        },
      ],
    }),
  );
  await renderHandler(ctx(deps, { renderId: "r-txt" }));

  assert.equal(spy.reframes.length, 0);
  assert.equal(spy.captioned.length, 1);
  assert.equal(spy.captioned[0].cueCount, 0, "no caption cues");
  assert.equal(spy.captioned[0].textOverlayCount, 1);
  assert.ok(spy.captioned[0].videoPath.endsWith("cut.mp4"), "composites over the cut, unreframed");
  assert.equal(spy.puts[0], "renders/r-txt/output.mp4");
});

test("animated captions with no words in range fall back to a plain render", async () => {
  const { deps, spy } = makeDeps(target({ burnCaptions: true, captionAnimation: "KARAOKE" }), {
    transcripts: { save: async () => ({ segmentCount: 0 }), loadSegments: async () => [], primaryLanguage: async () => "en", appendSegments: async () => ({ appended: 0, fromIndex: 0 }) },
  } as unknown as Partial<PipelineDeps>);
  await renderHandler(ctx(deps, { renderId: "r7" }));

  assert.equal(spy.captioned.length, 0);
  assert.equal(spy.reframes[0].subtitlePath, undefined);
});

test("a failing ffmpeg step marks the render FAILED and rethrows", async () => {
  const { deps, spy } = makeDeps(target(), {
    ffmpeg: {
      probe: async () => PROBE,
      extractAudio: async () => {},
      cut: async () => {
        throw new Error("ffmpeg exploded");
      },
      reframe: async () => {},
      reframeTracked: async () => {},
      thumbnail: async () => {},
    },
  } as unknown as Partial<PipelineDeps>);

  await assert.rejects(() => renderHandler(ctx(deps, { renderId: "r5" })), /ffmpeg exploded/);
  assert.deepEqual(spy.failed, [{ id: "r5", message: "ffmpeg exploded" }]);
  assert.equal(spy.completed.length, 0);
});

test("RENDER rejects a missing payload or an unknown render", async () => {
  const a = makeDeps(target());
  await assert.rejects(() => renderHandler(ctx(a.deps, {})), /missing renderId/);
  const b = makeDeps(null);
  await assert.rejects(() => renderHandler(ctx(b.deps, { renderId: "gone" })), /not found/);
});

test("auto focal point + a detected track uses the panning reframe", async () => {
  const { deps, spy } = makeDeps(target({ focalX: null, focalY: null }), {
    faces: {
      name: "fake",
      detectTrack: async () => [
        { atMs: 0, x: 0.4, y: 0.5 },
        { atMs: 5_000, x: 0.7, y: 0.5 },
      ],
    },
  } as unknown as Partial<PipelineDeps>);

  await renderHandler(ctx(deps, { renderId: "r8" }));
  assert.equal(spy.trackedReframes, 1);
  assert.equal(spy.reframes.length, 0);
  assert.equal(spy.puts[0], "renders/r8/output.mp4");
});

test("a pan-only capture window reuses the cheap crop path", async () => {
  const { deps, spy } = makeDeps(
    target({
      focusTrackJson: JSON.stringify([
        { atMs: 0, x: 0.2, y: 0.5, scale: 1 },
        { atMs: 28_000, x: 0.8, y: 0.5, scale: 1 },
      ]),
    }),
  );
  await renderHandler(ctx(deps, { renderId: "r-win" }));

  assert.equal(spy.zoomReframes.length, 0, "no zoom -> no zoompan");
  assert.equal(spy.trackedReframes, 1);
  const track = spy.trackedTracks[0];
  assert.ok(track.length > 2, "the window is flattened to a dense focal track");
  assert.equal(track[0].x, 0.2, "starts where the window starts");
  assert.equal(track[track.length - 1].atMs, 28_000, "and is pinned to the clip end");
  assert.ok(Math.abs(track[track.length - 1].x - 0.8) < 1e-9);
});

test("a capture window that zooms uses zoompan instead", async () => {
  const { deps, spy } = makeDeps(
    target({
      focusTrackJson: JSON.stringify([
        { atMs: 0, x: 0.5, y: 0.5, scale: 1 },
        { atMs: 28_000, x: 0.3, y: 0.3, scale: 2.5 },
      ]),
    }),
  );
  await renderHandler(ctx(deps, { renderId: "r-zoom" }));

  assert.equal(spy.trackedReframes, 0, "crop cannot change size");
  assert.equal(spy.zoomReframes.length, 1);
  assert.equal(spy.zoomReframes[0].aspect, "9:16");
  assert.equal(spy.zoomReframes[0].fps, 30, "fps comes from the probe, for on/fps");
  assert.equal(spy.zoomReframes[0].maxScale, 2.5);
});

test("an authored window beats a manual focal point and the face detector", async () => {
  const { deps, spy } = makeDeps(
    target({
      focalX: 0.9,
      focalY: 0.9,
      focusTrackJson: JSON.stringify([{ atMs: 0, x: 0.1, y: 0.1, scale: 1 }]),
    }),
    {
      faces: {
        name: "fake",
        detectTrack: async () => {
          throw new Error("the detector must not run when a window exists");
        },
      },
    } as unknown as Partial<PipelineDeps>,
  );
  await renderHandler(ctx(deps, { renderId: "r-prec" }));

  assert.equal(spy.reframes.length, 0, "the static focal point is not used");
  assert.equal(spy.trackedReframes, 1);
  assert.equal(spy.trackedTracks[0][0].x, 0.1, "the window won");
});

test("a corrupt capture window falls through rather than failing the render", async () => {
  const { deps, spy } = makeDeps(target({ focusTrackJson: "{ not json" }));
  await renderHandler(ctx(deps, { renderId: "r-bad" }));
  // Falls back to the clip's static focal point.
  assert.equal(spy.trackedReframes, 0);
  assert.equal(spy.zoomReframes.length, 0);
  assert.equal(spy.reframes.length, 1);
  assert.equal(spy.puts[0], "renders/r-bad/output.mp4");
});

test("a capture window reframes a 16:9 clip that would otherwise pass through", async () => {
  const { deps, spy } = makeDeps(
    target({
      aspectRatio: "LANDSCAPE_16_9",
      focusTrackJson: JSON.stringify([{ atMs: 0, x: 0.5, y: 0.5, scale: 2 }]),
    }),
  );
  await renderHandler(ctx(deps, { renderId: "r-16" }));
  // Without a window this clip skips the reframe entirely; a punch-in is still
  // a reframe even when the aspect is unchanged.
  assert.equal(spy.zoomReframes.length, 1);
  assert.equal(spy.zoomReframes[0].aspect, "16:9");
});

test("auto focal point but no detections falls back to the static centre reframe", async () => {
  const { deps, spy } = makeDeps(target({ focalX: null, focalY: null }));
  await renderHandler(ctx(deps, { renderId: "r9" }));
  assert.equal(spy.trackedReframes, 0);
  assert.equal(spy.reframes.length, 1);
  assert.equal(spy.reframes[0].focalX, undefined); // -> defaults to centre in the builder
});

test("cues reach Remotion on the clip's own timeline, not the source video's", async () => {
  // A clip that starts at 10s: fed absolute times the composition's clock never
  // reaches them, and the render comes out with no captions and no error.
  const { deps, spy } = makeDeps(
    target({ burnCaptions: true, captionAnimation: "POP" }),
    withTranscript(CENSOR_WORDS),
  );
  await renderHandler(ctx(deps, { renderId: "r-rebase" }));

  const cues = JSON.parse(spy.captioned[0].cueText) as Array<{ startMs: number }>;
  assert.ok(cues.length > 0, "cues are passed at all");
  assert.ok(
    cues.every((c) => c.startMs < 30_000),
    `cues must be clip-relative, got ${JSON.stringify(cues.map((c) => c.startMs))}`,
  );
  // The first word of the clip sits ~1s in, not ~11s.
  assert.ok(Math.abs(cues[0].startMs - 1_000) < 50, `got ${cues[0].startMs}`);
});

/** A timeline on the clip's own video: `[in,out]` pairs, in lane order. */
const timeline = (ranges: Array<[number, number]>, videoId = "vid1") => ({
  trackId: "t1",
  trackOrder: ["t1"],
  items: ranges.map(([sourceIn, sourceOut], order) => ({
    id: `i${order}`,
    trackId: "t1",
    order,
    sourceIn,
    sourceOut,
    sourceVideoId: videoId,
    sourceAssetId: null,
    sourceStorageKey: "videos/vid1/source.mp4",
  })),
});

test("an untouched timeline still renders as the single cut it always was", async () => {
  // One item covering the clip's window: opening the panel must not change the
  // bytes a render produces.
  const { deps, spy } = makeDeps(target({ sequence: timeline([[10_000, 38_000]]) }));
  await renderHandler(ctx(deps, { renderId: "r-plain" }));

  assert.equal(spy.concats.length, 0, "nothing to join");
  assert.equal(spy.cuts.length, 1);
  assert.deepEqual(spy.cuts[0], { startMs: 10_000, endMs: 38_000, crf: 20 });
});

test("a split timeline is cut piece by piece and joined in order", async () => {
  const { deps, spy } = makeDeps(
    target({ sequence: timeline([[10_000, 14_000], [30_000, 38_000]]) }),
  );
  await renderHandler(ctx(deps, { renderId: "r-compose" }));

  assert.deepEqual(
    spy.cuts.map((c) => [c.startMs, c.endMs]),
    [[10_000, 14_000], [30_000, 38_000]],
    "each piece is cut from its own range",
  );
  assert.equal(spy.concats.length, 1);
  assert.equal(spy.concats[0].pieces.length, 2);
  assert.equal(
    spy.concats[0].reencode,
    false,
    "one source means identical encoder settings, so the join can stream-copy",
  );
});

test("dropping the middle of a clip shortens what is rendered", async () => {
  // 4s + 8s of a 28s window: the output is 12s, and the Remotion path must be
  // told so or it would render 28 seconds of black past the end.
  const { deps, spy } = makeDeps(
    target({
      sequence: timeline([[10_000, 14_000], [30_000, 38_000]]),
      burnCaptions: true,
      captionAnimation: "POP",
    }),
    withTranscript(CENSOR_WORDS),
  );
  await renderHandler(ctx(deps, { renderId: "r-shorter" }));

  assert.equal(spy.captioned[0].durationMs, 12_000, "the timeline's length, not the clip's");
});

test("captions follow their footage when the timeline is rearranged", async () => {
  // CENSOR_WORDS: well 11.0, shit 12.0, that 13.0, worked 14.0. Keeping only
  // 13.0-13.6 and then 11.0-11.6 means "that" must now come before "well",
  // and the two words in the dropped stretches must not appear at all.
  const { deps, spy } = makeDeps(
    target({
      sequence: timeline([[13_000, 13_600], [11_000, 11_600]]),
      burnCaptions: true,
      captionAnimation: "POP",
    }),
    withTranscript(CENSOR_WORDS),
  );
  await renderHandler(ctx(deps, { renderId: "r-reorder" }));

  const cues = JSON.parse(spy.captioned[0].cueText) as Array<{ startMs: number; lines: string[] }>;
  const said = cues.flatMap((c) => c.lines.join(" ").split(/\s+/)).filter(Boolean);
  // "that" (13.0s) is now first; "well" (11.0s) follows it.
  assert.ok(said.indexOf("that") < said.indexOf("well"), `got ${said.join(" ")}`);
  assert.ok(!said.includes("worked"), "14.0s was trimmed out, so its word is gone");
  assert.ok(cues.every((c) => c.startMs < 3_000), "and everything sits inside the 3s output");
});

test("a piece from another video is fetched and forces a re-encode on the join", async () => {
  const seq = timeline([[10_000, 12_000]]);
  seq.items.push({
    id: "i1",
    trackId: "t1",
    order: 1,
    sourceIn: 0,
    sourceOut: 3_000,
    sourceVideoId: "vid2",
    sourceAssetId: null,
    sourceStorageKey: "videos/vid2/source.mp4",
  });
  const { deps, spy } = makeDeps(target({ sequence: seq }));
  await renderHandler(ctx(deps, { renderId: "r-mixed" }));

  assert.equal(spy.cuts.length, 2);
  // Every piece is cut to one shape first, so the join itself stays a copy.
  assert.equal(spy.concats[0].reencode, false);
  assert.ok(
    spy.cuts.every((c) => c.normalizeTo),
    "a mixed-source timeline normalises every piece — the demuxer cannot switch mid-stream",
  );
});

test("a single-source timeline is cut without any normalising", async () => {
  const { deps, spy } = makeDeps(
    target({ sequence: timeline([[10_000, 14_000], [30_000, 38_000]]) }),
  );
  await renderHandler(ctx(deps, { renderId: "r-onesource" }));
  assert.ok(
    spy.cuts.every((c) => !c.normalizeTo),
    "re-scaling footage that already matches would cost a pass and soften it",
  );
});

/** Two lanes: `base` plays through, `upper` is laid over it. */
const layered = (
  base: Array<[number, number]>,
  upper: Array<[number, number]>,
  videoId = "vid1",
) => ({
  trackId: "t1",
  trackOrder: ["t1", "t2"],
  items: [
    ...base.map(([sourceIn, sourceOut], order) => ({
      id: `b${order}`, trackId: "t1", order, sourceIn, sourceOut,
      sourceVideoId: videoId, sourceAssetId: null, sourceStorageKey: "videos/vid1/source.mp4",
    })),
    ...upper.map(([sourceIn, sourceOut], order) => ({
      id: `u${order}`, trackId: "t2", order, sourceIn, sourceOut,
      sourceVideoId: videoId, sourceAssetId: null, sourceStorageKey: "videos/vid1/source.mp4",
    })),
  ],
});

test("a piece dragged to another layer is laid over the base, not dropped", async () => {
  // The whole hazard of cross-lane dragging: a piece that leaves the base lane
  // must still reach the export, or moving it would quietly delete it.
  const { deps, spy } = makeDeps(
    target({ sequence: layered([[10_000, 20_000]], [[30_000, 32_000]]) }),
  );
  await renderHandler(ctx(deps, { renderId: "r-layer" }));

  assert.equal(spy.layered.length, 1, "the upper lane is composited");
  assert.equal(spy.layered[0].layers.length, 1);
  assert.equal(spy.layered[0].layers[0].startSec, 0, "its own lane packs from zero");
  // Both the base piece and the upper piece are cut.
  assert.deepEqual(
    spy.cuts.map((c) => [c.startMs, c.endMs]),
    [[10_000, 20_000], [30_000, 32_000]],
  );
});

test("an upper lane packs from zero, so its pieces keep their own order", async () => {
  const { deps, spy } = makeDeps(
    target({ sequence: layered([[10_000, 20_000]], [[30_000, 32_000], [34_000, 35_000]]) }),
  );
  await renderHandler(ctx(deps, { renderId: "r-layer2" }));

  assert.deepEqual(
    spy.layered[0].layers.map((l) => l.startSec),
    [0, 2],
    "the second layer piece follows the first, two seconds in",
  );
});

test("an untouched base with something on a layer still composes", async () => {
  // isPlainCut alone would take the single-cut path and lose the upper lane.
  const { deps, spy } = makeDeps(
    target({ sequence: layered([[10_000, 38_000]], [[5_000, 6_000]]) }),
  );
  await renderHandler(ctx(deps, { renderId: "r-layer3" }));

  assert.equal(spy.concats.length, 1, "the base still goes through the compose path");
  assert.equal(spy.layered.length, 1, "and the layer is not silently dropped");
});

test("no upper lane means no compositing pass at all", async () => {
  const { deps, spy } = makeDeps(target({ sequence: timeline([[10_000, 38_000]]) }));
  await renderHandler(ctx(deps, { renderId: "r-nolayer" }));
  assert.equal(spy.layered.length, 0);
  assert.equal(spy.concats.length, 0, "and it is still just the one cut");
});

test("combining clips from two videos captions and censors both", async () => {
  // The second recording's speech used to be invisible to the render: no
  // captions, and — the part that matters — no bleep. Profanity in an inserted
  // clip went out uncensored with nothing on screen saying so.
  const perVideo: Record<string, Segment[]> = {
    vid1: [
      {
        startMs: 0,
        endMs: 40_000,
        text: "well shit",
        words: [
          { id: "a1", text: "well", startMs: 10_500, endMs: 10_900 },
          { id: "a2", text: "shit", startMs: 11_500, endMs: 11_900 },
        ],
      },
    ],
    vid2: [
      {
        startMs: 0,
        endMs: 40_000,
        text: "damn fuck",
        words: [
          { id: "b1", text: "damn", startMs: 500, endMs: 900 },
          { id: "b2", text: "fuck", startMs: 1_500, endMs: 1_900 },
        ],
      },
    ],
  };
  const seq = timeline([[10_000, 12_000]]);
  seq.items.push({
    id: "i1", trackId: "t1", order: 1, sourceIn: 0, sourceOut: 2_000,
    sourceVideoId: "vid2", sourceAssetId: null, sourceStorageKey: "videos/vid2/source.mp4",
  });

  const { deps, spy } = makeDeps(
    target({ sequence: seq, censor: censorOn, burnCaptions: true, captionAnimation: "POP" }),
    {
      transcripts: {
        save: async () => ({ segmentCount: 0 }),
        loadSegments: async (videoId: string) => perVideo[videoId] ?? [],
      },
    } as unknown as Partial<PipelineDeps>,
  );
  await renderHandler(ctx(deps, { renderId: "r-twosrc" }));

  // "fuck" lives in the second video, 0.5s into a piece that starts at 2s.
  const spans = spy.censors[0].spans.map((s) => Math.round(s.startSec * 100) / 100);
  assert.ok(spans.some((s) => Math.abs(s - 1.44) < 0.02), `first video's word: ${spans}`);
  assert.ok(spans.some((s) => Math.abs(s - 3.44) < 0.02), `second video's word: ${spans}`);

  const text = spy.captioned[0].cueText;
  assert.ok(!text.includes("shit") && !text.includes("fuck"), `nothing raw survives: ${text}`);
  assert.ok(text.includes("well"), "the first video's clean words are captioned");
  assert.ok(text.includes("damn"), "and so are the second's");
});

test("narration follows its segment when the timeline is rearranged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "render-vo-seq-"));
  try {
    // Two segments; the timeline keeps only the second, and puts it first.
    // A line anchored to it must move with it, not sit where it used to be.
    const segments = [
      { startMs: 10_000, endMs: 12_000, text: "one", words: [] },
      { startMs: 20_000, endMs: 22_000, text: "two", words: [] },
    ];
    const { deps, spy } = makeDeps(
      target({
        sequence: timeline([[20_000, 22_000], [10_000, 12_000]]),
        voiceover: {
          duckDb: -9,
          linesJson: JSON.stringify({
            version: 1,
            lines: [{ ref: "seg:1", text: "narration", durationMs: 800, audioKey: "vo/a.wav" }],
          }),
        },
      }),
      {
        tempDir: dir,
        transcripts: { save: async () => ({ segmentCount: 0 }), loadSegments: async () => segments },
      } as unknown as Partial<PipelineDeps>,
    );
    await renderHandler(ctx(deps, { renderId: "r-vo-seq" }));

    // seg:1 is the 20s segment, which the timeline moved to the very front.
    // Against the clip's own timeline it would have been 10s in — that is the
    // drift this guards against.
    assert.equal(spy.voMixes.length, 1);
    assert.equal(spy.voMixes[0].lines[0].startMs, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("narration anchored to footage that was cut is not placed anyway", async () => {
  const dir = await mkdtemp(join(tmpdir(), "render-vo-gone-"));
  try {
    const segments = [
      { startMs: 10_000, endMs: 12_000, text: "kept", words: [] },
      { startMs: 30_000, endMs: 32_000, text: "dropped", words: [] },
    ];
    const { deps, spy } = makeDeps(
      target({
        // Only the first segment's footage survives.
        sequence: timeline([[10_000, 12_000]]),
        voiceover: {
          duckDb: -9,
          linesJson: JSON.stringify({
            version: 1,
            lines: [{ ref: "seg:1", text: "narration", durationMs: 800, audioKey: "vo/a.wav" }],
          }),
        },
      }),
      {
        tempDir: dir,
        transcripts: { save: async () => ({ segmentCount: 0 }), loadSegments: async () => segments },
      } as unknown as Partial<PipelineDeps>,
    );
    await renderHandler(ctx(deps, { renderId: "r-vo-gone" }));

    // There is no moment in the export that segment belongs to, so the line has
    // nowhere to go — dropping it beats narrating over whatever replaced it.
    assert.equal(spy.voMixes.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Interior cuts: words struck out of the middle -------------------------
//
// CENSOR_WORDS on a 10s-38s clip: well 11.0-11.3, shit 12.0-12.4,
// that 13.0-13.3, worked 14.0-14.4. Striking "shit" takes it plus 250ms of the
// silence either side (the gaps are 700ms and 600ms, so the cap applies), i.e.
// 11.75s-12.65s — 900ms out of a 28s clip.

test("a struck word is cut out and the clip is joined back together", async () => {
  const { deps, spy } = makeDeps(
    target({ removedWordIds: ["c2"] }),
    withTranscript(CENSOR_WORDS),
  );
  await renderHandler(ctx(deps, { renderId: "r-cut" }));

  assert.deepEqual(
    spy.cuts.map((c) => [c.startMs, c.endMs]),
    [[10_000, 11_750], [12_650, 38_000]],
    "the clip is cut either side of the struck word",
  );
  assert.equal(spy.concats.length, 1, "and the two halves are joined");
  assert.equal(spy.concats[0].pieces.length, 2);
  assert.equal(spy.concats[0].reencode, false, "one source, so the join streams");
});

test("striking a word shortens the render by exactly what it removed", async () => {
  const { deps, spy } = makeDeps(
    target({ removedWordIds: ["c2"], burnCaptions: true, captionAnimation: "POP" }),
    withTranscript(CENSOR_WORDS),
  );
  await renderHandler(ctx(deps, { renderId: "r-cut-len" }));

  assert.equal(spy.captioned[0].durationMs, 28_000 - 900);
});

test("the struck word leaves the captions, and the rest moves up to meet it", async () => {
  const { deps, spy } = makeDeps(
    target({ removedWordIds: ["c2"], burnCaptions: true, captionAnimation: "POP" }),
    withTranscript(CENSOR_WORDS),
  );
  await renderHandler(ctx(deps, { renderId: "r-cut-cap" }));

  const cues = JSON.parse(spy.captioned[0].cueText) as Array<{ startMs: number; lines: string[] }>;
  const said = cues.flatMap((c) => c.lines.join(" ").split(/\s+/)).filter(Boolean);
  assert.ok(!said.includes("shit"), `struck word still captioned: ${said.join(" ")}`);
  assert.deepEqual(said, ["well", "that", "worked"]);
  // "that" was spoken at 13.0s, 3.0s into the clip; it now lands 900ms earlier.
  const that = cues.find((c) => c.lines.join(" ").includes("that"));
  assert.equal(that?.startMs, 3_000 - 900);
});

test("a word that is both struck and censored is simply gone, not bleeped", async () => {
  const { deps, spy } = makeDeps(
    target({ removedWordIds: ["c2"], censor: censorOn }),
    withTranscript(CENSOR_WORDS),
  );
  await renderHandler(ctx(deps, { renderId: "r-cut-censor" }));

  // Bleeping a stretch that is no longer in the video would land the tone on
  // whatever the cut spliced in after it.
  assert.equal(spy.censors.length, 0, "nothing left to bleep");
});

test("overlay windows move back with the cut so they stay on their moment", async () => {
  const { deps, spy } = makeDeps(
    target({
      removedWordIds: ["c2"],
      overlays: [
        // Pinned to 5s-7s into the clip, which is after the 900ms that goes.
        { storageKey: "assets/image/a.png", animated: false, x: 0.5, y: 0.2, scale: 1, rotation: 0, opacity: 1, startMs: 5_000, endMs: 7_000, animationJson: null },
        // No window at all: nothing to move.
        { storageKey: "assets/gif/b.gif", animated: true, x: 0.1, y: 0.9, scale: 0.5, rotation: 0, opacity: 1, startMs: null, endMs: null, animationJson: null },
      ],
    }),
    withTranscript(CENSOR_WORDS),
  );
  await renderHandler(ctx(deps, { renderId: "r-cut-ov" }));

  assert.deepEqual(
    spy.composed[0].items.map((i) => [i.startSec, i.endSec]),
    [[4.1, 6.1], [null, null]],
  );
});

test("striking every word refuses the render instead of exporting nothing", async () => {
  const { deps } = makeDeps(
    target({ startMs: 11_000, endMs: 11_300, removedWordIds: ["c1"] }),
    withTranscript(CENSOR_WORDS),
  );
  await assert.rejects(
    renderHandler(ctx(deps, { renderId: "r-cut-all" })),
    /struck out/,
  );
});

test("ids that match nothing leave the render exactly as it was", async () => {
  const { deps, spy } = makeDeps(
    // A word deleted from the transcript since it was struck is not a reason
    // to refuse to export, or to take the slow multi-piece path.
    target({ removedWordIds: ["gone-from-the-transcript"] }),
    withTranscript(CENSOR_WORDS),
  );
  await renderHandler(ctx(deps, { renderId: "r-cut-none" }));

  assert.deepEqual(spy.cuts.map((c) => [c.startMs, c.endMs]), [[10_000, 38_000]]);
  assert.equal(spy.concats.length, 0, "one piece needs no join");
});
