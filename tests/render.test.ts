import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JobContext, JobRecord } from "../src/lib/jobs/types.ts";
import type { CutOptions, MediaInfo, ReframeOptions } from "../src/lib/ffmpeg/run.ts";
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
      { text: "one", startMs: 10_500, endMs: 10_900 },
      { text: "two", startMs: 11_000, endMs: 11_400 },
      { text: "three", startMs: 11_500, endMs: 11_900 },
      { text: "four", startMs: 39_000, endMs: 39_500 }, // outside a 10s..38s clip
    ],
  },
];

interface Spy {
  began: string[];
  completed: Array<{ id: string; outputKey: string }>;
  failed: Array<{ id: string; message: string }>;
  cuts: CutOptions[];
  reframes: ReframeOptions[];
  probed: string[];
  puts: string[];
}

function makeDeps(target: RenderTarget | null, over: Partial<PipelineDeps> = {}) {
  const spy: Spy = { began: [], completed: [], failed: [], cuts: [], reframes: [], probed: [], puts: [] };
  const deps = {
    tempDir: "/tmp/render-test",
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

test("captions are burned: an SRT of the in-range words is passed to reframe", async () => {
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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
