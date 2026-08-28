import test from "node:test";
import assert from "node:assert/strict";

import type { JobContext, JobKind, JobRecord } from "../src/lib/jobs/types.ts";
import type { Segment, TranscriptResult } from "../src/lib/providers/types.ts";
import type { MediaInfo } from "../src/lib/ffmpeg/run.ts";
import type { PipelineDeps } from "../src/lib/pipeline/deps.ts";
import { PIPELINE_HANDLERS } from "../src/lib/pipeline/index.ts";
import {
  analyzeHandler,
  extractAudioHandler,
  fetchHandler,
  probeHandler,
  transcribeHandler,
} from "../src/lib/pipeline/handlers.ts";
import { buildYtDlpArgs } from "../src/lib/pipeline/fetcher.ts";

const SEGMENTS: Segment[] = [
  { startMs: 0, endMs: 15_000, text: "Welcome to the show today.", words: [] },
  { startMs: 15_000, endMs: 30_000, text: "Here is the first big idea we cover.", words: [] },
  { startMs: 30_000, endMs: 45_000, text: "And the second point follows right after.", words: [] },
  { startMs: 45_000, endMs: 62_000, text: "This is the surprising twist nobody expects.", words: [] },
  { startMs: 62_000, endMs: 78_000, text: "We wrap that thread up neatly.", words: [] },
  { startMs: 78_000, endMs: 90_000, text: "Thanks for listening, goodbye.", words: [] },
];

const TRANSCRIPT: TranscriptResult = {
  provider: "fake",
  model: "fake-1",
  language: "en",
  confidence: 0.9,
  segments: SEGMENTS,
};

const PROBE_INFO: MediaInfo = {
  durationMs: 120_000,
  width: 1920,
  height: 1080,
  fps: 30,
  videoCodec: "h264",
  audioCodec: "aac",
  hasAudio: true,
  audioChannels: 2,
  sampleRate: 48_000,
  sizeBytes: 4_200_000,
};

interface Spy {
  enqueued: Array<{ videoId: string; kind: JobKind; payload?: unknown }>;
  statuses: string[];
  puts: string[];
  gets: string[];
  extracted: Array<[string, string]>;
  probed: MediaInfo | null;
  savedTranscript: TranscriptResult | null;
  savedClips: unknown[] | null;
  fetched: string | null;
  fetchedTo: string | null;
  filename: string | null;
  sourceEnsured: string[];
  evicted: string[];
}

function makeDeps(over: Partial<PipelineDeps> = {}): { deps: PipelineDeps; spy: Spy } {
  const spy: Spy = {
    enqueued: [],
    statuses: [],
    puts: [],
    gets: [],
    extracted: [],
    probed: null,
    savedTranscript: null,
    savedClips: null,
    fetched: null,
    fetchedTo: null,
    filename: null,
    sourceEnsured: [],
    evicted: [],
  };
  const video = { id: "vid1", storageKey: "videos/vid1/source.mp4", durationMs: null as number | null, status: "UPLOADED" };

  const deps: PipelineDeps = {
    tempDir: "/tmp/clipper-test",
    ffmpeg: {
      probe: async () => {
        spy.probed = PROBE_INFO;
        return PROBE_INFO;
      },
      extractAudio: async (i, o) => {
        spy.extracted.push([i, o]);
      },
      cut: async () => {},
      reframe: async () => {},
      reframeTracked: async () => {},
      thumbnail: async () => {},
      composeOverlays: async () => {},
    },
    storage: {
      name: "fake",
      getToFile: async (key) => {
        spy.gets.push(key);
      },
      putFile: async (key) => {
        spy.puts.push(key);
      },
      createUploadUrl: async () => "",
      createDownloadUrl: async () => "",
      delete: async () => {},
      exists: async () => false,
    },
    source: {
      localPath: (videoId) => `/tmp/clipper-test/videos/${videoId}/source`,
      ensureLocal: async (videoId, storageKey) => {
        spy.sourceEnsured.push(storageKey);
        return `/tmp/clipper-test/videos/${videoId}/source`;
      },
      evict: async (videoId) => {
        spy.evicted.push(videoId);
      },
    },
    transcription: {
      name: "fake",
      transcribe: async () => TRANSCRIPT,
    },
    analysis: {
      name: "fake",
      suggestClips: async () => [
        {
          startMs: 32_000,
          endMs: 58_000,
          title: "The twist",
          hook: "Nobody expects this.",
          description: "",
          reason: "",
          caption: "",
          socialTitle: "",
          hashtags: [],
          score: 0.8,
        },
      ],
    },
    videos: {
      get: async (id) => (id === video.id ? { ...video } : null),
      applyProbe: async (_id, info) => {
        spy.probed = info;
        video.durationMs = info.durationMs;
      },
      setStatus: async (_id, s) => {
        spy.statuses.push(s);
        video.status = s;
      },
      setError: async () => {},
      setFilename: async (_id, name) => {
        spy.filename = name;
      },
    },
    transcripts: {
      save: async (_id, result) => {
        spy.savedTranscript = result;
        return { segmentCount: result.segments.length };
      },
      loadSegments: async () => spy.savedTranscript?.segments ?? SEGMENTS,
    },
    clips: {
      replaceSuggested: async (_id, clips) => {
        spy.savedClips = clips;
        return clips.length;
      },
    },
    renders: {
      loadTarget: async () => null,
      begin: async () => {},
      complete: async () => {},
      fail: async () => {},
    },
    thumbnails: {
      target: async () => null,
      targetsForVideo: async () => [],
      setKey: async () => {},
    },
    captions: { renderCaptioned: async () => {} },
    faces: { name: "none", detectTrack: async () => [] },
    fetcher: {
      name: "fake",
      fetch: async (url: string, out: string) => {
        spy.fetched = url;
        spy.fetchedTo = out;
        return { title: "Fetched Title" };
      },
    },
    queue: {
      enqueue: async (input) => {
        spy.enqueued.push(input);
        return `job-${spy.enqueued.length}`;
      },
    },
    ...over,
  };
  return { deps, spy };
}

function ctx(deps: PipelineDeps, kind: JobKind, payload: unknown = null): JobContext<PipelineDeps> {
  const job: JobRecord = {
    id: "j1",
    videoId: "vid1",
    kind,
    status: "PROCESSING",
    attempts: 1,
    maxAttempts: 3,
    progress: 0,
    payload,
    runAfter: new Date(),
  };
  return { job, deps, signal: new AbortController().signal, setProgress: async () => {} };
}

// --- individual handlers -------------------------------------------

test("FETCH downloads the URL, stores it, sets the title, queues PROBE", async () => {
  const { deps, spy } = makeDeps();
  const result = await fetchHandler(ctx(deps, "FETCH", { url: "https://youtu.be/abc123" }));

  assert.equal(spy.fetched, "https://youtu.be/abc123");
  assert.equal(spy.puts[0], "videos/vid1/source.mp4");
  assert.equal(spy.fetchedTo, "/tmp/clipper-test/videos/vid1/source"); // primes the cache
  assert.equal(spy.filename, "Fetched Title");
  assert.equal(spy.statuses.includes("UPLOADED"), true);
  assert.deepEqual(spy.enqueued, [{ videoId: "vid1", kind: "PROBE" }]);
  assert.equal((result as { title: string }).title, "Fetched Title");
});

test("buildYtDlpArgs adds --impersonate for Cloudflare-fronted hosts (Rumble), omits it when disabled", () => {
  const withImp = buildYtDlpArgs("https://rumble.com/v6k90ss-x.html", "/tmp/videos/v/source", 5_000_000, "chrome");
  const i = withImp.indexOf("--impersonate");
  assert.ok(i >= 0 && withImp[i + 1] === "chrome");

  const without = buildYtDlpArgs("https://rumble.com/v6k90ss-x.html", "/tmp/videos/v/source", 5_000_000, "");
  assert.equal(without.includes("--impersonate"), false);
  assert.ok(without.includes("--merge-output-format") && without.includes("--print-json"));
});

test("FETCH throws without a url in the payload", async () => {
  const { deps } = makeDeps();
  await assert.rejects(() => fetchHandler(ctx(deps, "FETCH", {})), /missing url/);
});

test("PROBE stores media info and queues EXTRACT_AUDIO", async () => {
  const { deps, spy } = makeDeps();
  const result = await probeHandler(ctx(deps, "PROBE"));

  assert.equal(spy.sourceEnsured[0], "videos/vid1/source.mp4");
  assert.equal(spy.statuses.includes("PROBING"), true);
  assert.equal(spy.probed?.durationMs, 120_000);
  assert.deepEqual(spy.enqueued, [{ videoId: "vid1", kind: "EXTRACT_AUDIO" }]);
  assert.equal((result as MediaInfo).width, 1920);
});

test("EXTRACT_AUDIO runs ffmpeg, uploads the wav, queues TRANSCRIBE", async () => {
  const { deps, spy } = makeDeps();
  const result = await extractAudioHandler(ctx(deps, "EXTRACT_AUDIO"));

  assert.equal(spy.extracted.length, 1);
  assert.equal(spy.sourceEnsured[0], "videos/vid1/source.mp4");
  assert.equal(spy.puts[0], "videos/vid1/audio.wav");
  assert.deepEqual(spy.enqueued[0], {
    videoId: "vid1",
    kind: "TRANSCRIBE",
    payload: { audioKey: "videos/vid1/audio.wav" },
  });
  assert.deepEqual(result, { audioKey: "videos/vid1/audio.wav" });
});

test("TRANSCRIBE persists the transcript, flips status to READY, queues ANALYZE", async () => {
  const { deps, spy } = makeDeps();
  const result = await transcribeHandler(ctx(deps, "TRANSCRIBE", { audioKey: "videos/vid1/audio.wav" }));

  assert.equal(spy.gets[0], "videos/vid1/audio.wav");
  assert.equal(spy.savedTranscript?.segments.length, 6);
  assert.deepEqual(spy.statuses, ["TRANSCRIBING", "READY"]);
  assert.deepEqual(spy.enqueued, [{ videoId: "vid1", kind: "ANALYZE" }]);
  assert.deepEqual(result, { segmentCount: 6, language: "en" });
});

test("ANALYZE refines suggestions and writes them as clips", async () => {
  const { deps, spy } = makeDeps();
  spy.savedTranscript = TRANSCRIPT; // loadSegments will return these

  const result = await analyzeHandler(
    ctx(deps, "ANALYZE", { minClipMs: 15_000, maxClipMs: 45_000, maxTotalRatio: 0.9 }),
  );

  assert.equal((result as { clipCount: number }).clipCount, 1);
  assert.equal(spy.savedClips?.length, 1);
  const clip = spy.savedClips![0] as { startMs: number; endMs: number; title: string };
  // snapped to segments 2..3 (30000..62000) then padded by 250 / 400
  assert.equal(clip.startMs, 30_000 - 250);
  assert.equal(clip.endMs, 62_000 + 400);
  assert.equal(clip.title, "The twist");
  assert.deepEqual(spy.enqueued, [{ videoId: "vid1", kind: "THUMBNAIL" }]);
});

test("ANALYZE does not queue thumbnails when it produced no clips", async () => {
  const { deps, spy } = makeDeps({ analysis: { name: "fake", suggestClips: async () => [] } });
  spy.savedTranscript = TRANSCRIPT;
  await analyzeHandler(ctx(deps, "ANALYZE"));
  assert.equal(spy.enqueued.length, 0);
});

test("ANALYZE throws when there is no transcript", async () => {
  const { deps } = makeDeps({
    transcripts: { save: async () => ({ segmentCount: 0 }), loadSegments: async () => [] },
  });
  await assert.rejects(() => analyzeHandler(ctx(deps, "ANALYZE")), /no transcript segments/);
});

test("PROBE throws for an unknown video", async () => {
  const { deps } = makeDeps();
  const c = ctx(deps, "PROBE");
  (c.job as { videoId: string }).videoId = "missing";
  await assert.rejects(() => probeHandler(c), /not found/);
});

// --- the whole chain, one handler feeding the next ---------------

test("the ingest chain runs PROBE -> EXTRACT_AUDIO -> TRANSCRIBE -> ANALYZE -> THUMBNAIL", async () => {
  const { deps, spy } = makeDeps();

  const queue: Array<{ kind: JobKind; payload?: unknown }> = [{ kind: "PROBE" }];
  while (queue.length > 0) {
    const next = queue.shift()!;
    const handler = PIPELINE_HANDLERS[next.kind]!;
    const before = spy.enqueued.length;
    await handler(ctx(deps, next.kind, next.payload ?? null));
    for (const e of spy.enqueued.slice(before)) queue.push({ kind: e.kind, payload: e.payload });
  }

  assert.deepEqual(
    spy.enqueued.map((e) => e.kind),
    ["EXTRACT_AUDIO", "TRANSCRIBE", "ANALYZE", "THUMBNAIL"],
  );
  assert.equal(spy.statuses.at(-1), "READY");
  assert.equal(spy.savedClips?.length, 1);
});
