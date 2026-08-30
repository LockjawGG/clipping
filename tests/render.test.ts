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
    textOverlayCount: number;
    imageOverlays: Array<{ path: string; animationJson: string | null }>;
  }>;
  composed: OverlayCompositeOptions[];
  censors: Array<{ input: string; mode: string; spans: Array<{ startSec: number; endSec: number }> }>;
  evicted: string[];
}

function makeDeps(target: RenderTarget | null, over: Partial<PipelineDeps> = {}) {
  const tempDir = (over.tempDir as string | undefined) ?? "/tmp/render-test";
  const spy: Spy = {
    began: [],
    completed: [],
    failed: [],
    cuts: [],
    reframes: [],
    trackedReframes: 0,
    trackedTracks: [],
    zoomReframes: [],
    probed: [],
    puts: [],
    captioned: [],
    composed: [],
    censors: [],
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
        textOverlays?: unknown[];
        imageOverlays?: Array<{ path: string; animationJson: string | null }>;
      }) => {
        spy.captioned.push({
          preset: input.preset,
          videoPath: input.videoPath,
          cueCount: input.cues.length,
          cueText: JSON.stringify(input.cues),
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
    censor: {
      enabled: false,
      sensitivity: "MEDIUM",
      captionMode: "FULL",
      audioMode: "BEEP",
      replacement: null,
      allowList: [],
      denyList: [],
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
  audioMode: "BEEP" as const,
  replacement: null,
  allowList: [],
  denyList: [],
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

test("censoring works with captions off — the words only drive the bleep", async () => {
  const { deps, spy } = makeDeps(
    target({ censor: censorOn, burnCaptions: false }),
    withTranscript(CENSOR_WORDS),
  );
  await renderHandler(ctx(deps, { renderId: "r-nocap" }));
  assert.equal(spy.censors.length, 1);
  assert.equal(spy.captioned.length, 0, "no caption pass was triggered");
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
