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
  probed: string[];
  puts: string[];
  captioned: Array<{ preset: string; videoPath: string; cueCount: number }>;
  composed: OverlayCompositeOptions[];
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
    probed: [],
    puts: [],
    captioned: [],
    composed: [],
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
      reframeTracked: async () => {
        spy.trackedReframes++;
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
      renderCaptioned: async (input: { preset: string; videoPath: string; cues: unknown[] }) => {
        spy.captioned.push({ preset: input.preset, videoPath: input.videoPath, cueCount: input.cues.length });
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
    quality: "P1080",
    burnCaptions: false,
    captionAnimation: "NONE",
    captionStyle: null,
    textStyle: null,
    wordRules: [],
    overlays: [],
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
          { storageKey: "assets/image/a.png", animated: false, x: 0.5, y: 0.2, scale: 1, opacity: 0.8, startMs: 2000, endMs: 6000 },
          { storageKey: "assets/gif/b.gif", animated: true, x: 0.1, y: 0.9, scale: 0.5, opacity: 1, startMs: null, endMs: null },
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

test("auto focal point but no detections falls back to the static centre reframe", async () => {
  const { deps, spy } = makeDeps(target({ focalX: null, focalY: null }));
  await renderHandler(ctx(deps, { renderId: "r9" }));
  assert.equal(spy.trackedReframes, 0);
  assert.equal(spy.reframes.length, 1);
  assert.equal(spy.reframes[0].focalX, undefined); // -> defaults to centre in the builder
});
