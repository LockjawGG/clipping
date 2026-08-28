import test from "node:test";
import assert from "node:assert/strict";

import type { JobContext, JobRecord } from "../src/lib/jobs/types.ts";
import type { PipelineDeps, ThumbnailTarget } from "../src/lib/pipeline/deps.ts";
import { thumbnailHandler } from "../src/lib/pipeline/handlers.ts";

interface Spy {
  gets: string[];
  thumbs: Array<{ atMs: number; width?: number }>;
  puts: string[];
  keyed: Array<[string, string]>;
  videoKeyed: Array<[string, string]>;
  evicted: string[];
}

function makeDeps(opts: {
  target?: ThumbnailTarget | null;
  forVideo?: ThumbnailTarget[];
  poster?: { durationMs: number | null; hasThumbnail: boolean } | null;
}) {
  const spy: Spy = { gets: [], thumbs: [], puts: [], keyed: [], videoKeyed: [], evicted: [] };
  const deps = {
    tempDir: "/tmp/thumb-test",
    ffmpeg: {
      probe: async () => ({}),
      extractAudio: async () => {},
      cut: async () => {},
      reframe: async () => {},
      thumbnail: async (_i: string, _o: string, o: { atMs: number; width?: number }) => {
        spy.thumbs.push(o);
      },
    },
    storage: {
      name: "fake",
      getToFile: async (key: string) => {
        spy.gets.push(key);
      },
      putFile: async (key: string) => {
        spy.puts.push(key);
      },
      createUploadUrl: async () => "",
      createDownloadUrl: async () => "",
      delete: async () => {},
      exists: async () => true,
    },
    source: {
      localPath: (videoId: string) => `/tmp/thumb-test/videos/${videoId}/source`,
      ensureLocal: async (videoId: string, key: string) => {
        spy.gets.push(key);
        return `/tmp/thumb-test/videos/${videoId}/source`;
      },
      evict: async (videoId: string) => {
        spy.evicted.push(videoId);
      },
    },
    thumbnails: {
      target: async () => opts.target ?? null,
      targetsForVideo: async () => opts.forVideo ?? [],
      setKey: async (clipId: string, key: string) => {
        spy.keyed.push([clipId, key]);
      },
      videoPosterTarget: async () =>
        opts.poster
          ? { videoId: "vidA", sourceKey: "videos/vidA/source.mp4", ...opts.poster }
          : null,
      setVideoKey: async (videoId: string, key: string) => {
        spy.videoKeyed.push([videoId, key]);
      },
    },
  } as unknown as PipelineDeps;
  return { deps, spy };
}

function ctx(deps: PipelineDeps, payload: unknown): JobContext<PipelineDeps> {
  const job: JobRecord = {
    id: "j1",
    videoId: "vidA",
    kind: "THUMBNAIL",
    status: "PROCESSING",
    attempts: 1,
    maxAttempts: 3,
    progress: 0,
    payload,
    runAfter: new Date(),
  };
  return { job, deps, signal: new AbortController().signal, setProgress: async () => {} };
}

const t = (clipId: string, startMs: number, endMs: number): ThumbnailTarget => ({
  clipId,
  sourceKey: "videos/vidA/source.mp4",
  startMs,
  endMs,
});

test("THUMBNAIL with a clipId grabs one frame at the clip midpoint", async () => {
  const { deps, spy } = makeDeps({ target: t("c1", 10_000, 30_000) });
  const out = await thumbnailHandler(ctx(deps, { clipId: "c1" }));

  assert.deepEqual(spy.gets, ["videos/vidA/source.mp4"]);
  assert.deepEqual(spy.thumbs, [{ atMs: 20_000, width: 640 }]);
  assert.deepEqual(spy.puts, ["clips/c1/thumb.jpg"]);
  assert.deepEqual(spy.keyed, [["c1", "clips/c1/thumb.jpg"]]);
  assert.deepEqual(out, { generated: 1 });
});

test("THUMBNAIL with no clipId does every clip of the video, downloading the source once", async () => {
  const { deps, spy } = makeDeps({
    forVideo: [t("c1", 0, 20_000), t("c2", 40_000, 70_000)],
  });
  const out = await thumbnailHandler(ctx(deps, null));

  assert.equal(spy.gets.length, 1); // one download
  assert.deepEqual(
    spy.thumbs.map((x) => x.atMs),
    [10_000, 55_000],
  );
  assert.deepEqual(spy.keyed, [
    ["c1", "clips/c1/thumb.jpg"],
    ["c2", "clips/c2/thumb.jpg"],
  ]);
  assert.deepEqual(out, { generated: 2 });
});

test("THUMBNAIL is a no-op when there is nothing to do", async () => {
  const { deps, spy } = makeDeps({ forVideo: [] });
  assert.deepEqual(await thumbnailHandler(ctx(deps, null)), { generated: 0 });
  assert.equal(spy.gets.length, 0);

  const missing = makeDeps({ target: null });
  assert.deepEqual(await thumbnailHandler(ctx(missing.deps, { clipId: "gone" })), { generated: 0 });
});

test("THUMBNAIL on a full run makes a video poster at 25% when the video has none", async () => {
  const { deps, spy } = makeDeps({
    forVideo: [t("c1", 0, 20_000)],
    poster: { durationMs: 40_000, hasThumbnail: false },
  });
  const out = await thumbnailHandler(ctx(deps, null));

  assert.equal(spy.gets.length, 1); // still one download for poster + clips
  assert.deepEqual(spy.thumbs.map((x) => x.atMs), [10_000, 10_000]); // poster @25% of 40s, then clip midpoint
  assert.deepEqual(spy.puts, ["videos/vidA/poster.jpg", "clips/c1/thumb.jpg"]);
  assert.deepEqual(spy.videoKeyed, [["vidA", "videos/vidA/poster.jpg"]]);
  assert.deepEqual(out, { generated: 2 });
});

test("THUMBNAIL skips the poster when the video already has one", async () => {
  const { deps, spy } = makeDeps({
    forVideo: [],
    poster: { durationMs: 40_000, hasThumbnail: true },
  });
  const out = await thumbnailHandler(ctx(deps, null));
  assert.deepEqual(spy.videoKeyed, []);
  assert.deepEqual(out, { generated: 0 });
  assert.equal(spy.gets.length, 0);
});

test("THUMBNAIL makes a poster even for a video with no clips", async () => {
  const { deps, spy } = makeDeps({
    forVideo: [],
    poster: { durationMs: null, hasThumbnail: false },
  });
  const out = await thumbnailHandler(ctx(deps, null));
  assert.deepEqual(spy.thumbs.map((x) => x.atMs), [3000]); // no duration -> 3s fallback
  assert.deepEqual(spy.videoKeyed, [["vidA", "videos/vidA/poster.jpg"]]);
  assert.deepEqual(out, { generated: 1 });
});

test("THUMBNAIL with a clipId never touches the video poster", async () => {
  const { deps, spy } = makeDeps({
    target: t("c1", 10_000, 30_000),
    poster: { durationMs: 40_000, hasThumbnail: false },
  });
  await thumbnailHandler(ctx(deps, { clipId: "c1" }));
  assert.deepEqual(spy.videoKeyed, []);
  assert.deepEqual(spy.puts, ["clips/c1/thumb.jpg"]);
});
