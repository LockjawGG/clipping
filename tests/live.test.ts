import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StorageProvider } from "../src/lib/providers/types.ts";
import type { LiveServiceDeps } from "../src/lib/api/live.ts";
import {
  addChunkSchema,
  addLiveChunk,
  liveTranscriptSince,
  startLive,
  startLiveSchema,
  stopLive,
} from "../src/lib/api/live.ts";
import { ApiError } from "../src/lib/api/http.ts";
import type { PipelineDeps } from "../src/lib/pipeline/deps.ts";
import { liveFinalizeHandler, liveTranscribeHandler } from "../src/lib/pipeline/live-handlers.ts";
import type { JobContext, JobRecord } from "../src/lib/jobs/types.ts";

/* ------------------------------------------------------- service fakes */

function fakeStorage(): StorageProvider {
  return {
    name: "fake",
    createUploadUrl: async (k) => `https://up/${k}`,
    createDownloadUrl: async (k) => `https://dl/${k}`,
    putFile: async () => {},
    getToFile: async () => {},
    delete: async () => {},
    exists: async () => true,
  };
}

function makeDeps(over: Partial<LiveServiceDeps> = {}) {
  const videos = new Map<string, { id: string; status: string; storageKey: string; userId: string }>();
  const chunks: Array<{ id: string; videoId: string; index: number; startMs: number; status: string; storageKey: string }> = [];
  const segs: Array<{ index: number; startMs: number; endMs: number; text: string; speaker: string | null }> = [];
  let seq = 0;
  const enqueued: Array<{ videoId: string; kind: string; payload?: unknown }> = [];

  const db: LiveServiceDeps["db"] = {
    video: {
      create: async ({ data }) => {
        const id = `v${++seq}`;
        videos.set(id, {
          id,
          status: String(data.status),
          storageKey: String(data.storageKey),
          userId: "u1",
        });
        return { id };
      },
      findUnique: async ({ where }) => {
        const v = videos.get(where.id);
        return v ? ({ ...v, project: { userId: v.userId } } as never) : null;
      },
      update: async ({ where, data }) => {
        const v = videos.get(where.id);
        if (v && typeof data.status === "string") v.status = data.status;
        return {};
      },
    },
    liveChunk: {
      create: async ({ data }) => {
        const row = {
          id: `c${++seq}`,
          videoId: String(data.videoId),
          index: Number(data.index),
          startMs: Number(data.startMs),
          status: "PENDING",
          storageKey: String(data.storageKey),
        };
        chunks.push(row);
        return row as never;
      },
      findFirst: async ({ where }) =>
        (chunks.find((c) => c.videoId === (where as { videoId?: string }).videoId) ?? null) as never,
    },
    transcriptSegment: {
      findMany: async ({ where }) => {
        const gt = ((where as { index?: { gt?: number } }).index?.gt ?? -1) as number;
        return segs
          .filter((s) => s.index > gt)
          .map((s) => ({ ...s, words: [] })) as never;
      },
    },
  };

  const deps: LiveServiceDeps = {
    db,
    storage: fakeStorage(),
    userId: "u1",
    defaultProjectId: async () => "p1",
    assertProjectOwned: async (p) => {
      if (p !== "p1") throw new ApiError(404, "not found");
    },
    enqueue: async (i) => {
      enqueued.push(i);
      return `job-${enqueued.length}`;
    },
    ...over,
  };
  return { deps, videos, chunks, segs, enqueued };
}

/* --------------------------------------------------------------- tests */

test("schemas: startLive optional, addChunk requires index + startMs", () => {
  assert.doesNotThrow(() => startLiveSchema.parse({}));
  assert.doesNotThrow(() => addChunkSchema.parse({ index: 0, startMs: 0 }));
  assert.throws(() => addChunkSchema.parse({ index: -1, startMs: 0 }));
  assert.throws(() => addChunkSchema.parse({ startMs: 0 }));
});

test("startLive creates a LIVE video in the default project", async () => {
  const { deps, videos } = makeDeps();
  const out = await startLive(deps, {});
  assert.equal(videos.get(out.videoId)!.status, "LIVE");
  assert.equal(out.projectId, "p1");
});

test("addLiveChunk stores a fragment and returns a PUT, without queuing any job", async () => {
  const { deps, chunks, enqueued } = makeDeps();
  const { videoId } = await startLive(deps, {});
  const out = await addLiveChunk(deps, videoId, { index: 0, startMs: 0 });
  assert.match(out.upload.url, /chunks\/00000\.webm$/);
  assert.equal(chunks.length, 1);
  assert.ok(out.chunkId);
  assert.deepEqual(enqueued, []); // fragments are transcribed only at finalize
});

test("addLiveChunk 409s once the recording is no longer LIVE", async () => {
  const { deps, videos } = makeDeps();
  const { videoId } = await startLive(deps, {});
  videos.get(videoId)!.status = "READY";
  await assert.rejects(
    () => addLiveChunk(deps, videoId, { index: 1, startMs: 8000 }),
    (e: unknown) => e instanceof ApiError && e.status === 409,
  );
});

test("live routes 404 for another user's recording", async () => {
  const { deps, videos } = makeDeps();
  const { videoId } = await startLive(deps, {});
  videos.get(videoId)!.userId = "someone-else";
  await assert.rejects(
    () => liveTranscriptSince(deps, videoId, -1),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
});

test("liveTranscriptSince returns only segments after the cursor", async () => {
  const { deps, segs } = makeDeps();
  const { videoId } = await startLive(deps, {});
  segs.push(
    { index: 0, startMs: 0, endMs: 1000, text: "hello", speaker: null },
    { index: 1, startMs: 1000, endMs: 2000, text: "world", speaker: null },
  );
  const out = await liveTranscriptSince(deps, videoId, 0);
  assert.deepEqual(out.segments.map((s) => s.text), ["world"]);
  assert.equal(out.lastIndex, 1);
});

test("stopLive with chunks -> PROBING + LIVE_FINALIZE; with none -> FAILED", async () => {
  const withChunks = makeDeps();
  const a = await startLive(withChunks.deps, {});
  await addLiveChunk(withChunks.deps, a.videoId, { index: 0, startMs: 0 });
  const s1 = await stopLive(withChunks.deps, a.videoId);
  assert.equal(s1.status, "PROBING");
  assert.equal(withChunks.enqueued.at(-1)!.kind, "LIVE_FINALIZE");

  const empty = makeDeps();
  const b = await startLive(empty.deps, {});
  const s2 = await stopLive(empty.deps, b.videoId);
  assert.equal(s2.status, "FAILED");
});

/* ---------------------------------------------------- handler fakes */

function jobCtx(deps: PipelineDeps, kind: string, payload: unknown): JobContext<PipelineDeps> {
  const job = {
    id: "j1",
    videoId: "vidL",
    kind,
    status: "PROCESSING",
    attempts: 1,
    maxAttempts: 3,
    progress: 0,
    payload,
    runAfter: new Date(),
  } as JobRecord;
  return { job, deps, signal: new AbortController().signal, setProgress: async () => {} };
}

test("LIVE_TRANSCRIBE transcribes a chunk and appends offset segments", async () => {
  const appended: Array<{ startMs: number; text: string }> = [];
  let chunkStatus = "PENDING";
  const deps = {
    tempDir: "/tmp/live-test",
    ffmpeg: { extractAudio: async () => {} },
    storage: { getToFile: async () => {}, exists: async () => true },
    transcription: {
      transcribe: async () => ({
        provider: "fake",
        language: "en",
        segments: [{ startMs: 100, endMs: 900, text: "chunk words", words: [{ text: "chunk", startMs: 100, endMs: 500 }] }],
      }),
    },
    liveChunks: {
      get: async () => ({ id: "c1", videoId: "vidL", index: 2, startMs: 16_000, storageKey: "k", status: chunkStatus }),
      setStatus: async (_id: string, s: string) => {
        chunkStatus = s;
      },
      listForVideo: async () => [],
    },
    transcripts: {
      appendSegments: async (_v: string, i: { segments: Array<{ startMs: number; text: string }> }) => {
        appended.push(...i.segments.map((s) => ({ startMs: s.startMs, text: s.text })));
        return { appended: i.segments.length, fromIndex: 0 };
      },
    },
  } as unknown as PipelineDeps;

  await liveTranscribeHandler(jobCtx(deps, "LIVE_TRANSCRIBE", { chunkId: "c1" }));
  assert.deepEqual(appended, [{ startMs: 16_100, text: "chunk words" }]); // offset by chunk.startMs
  assert.equal(chunkStatus, "DONE");
});

test("LIVE_FINALIZE reassembles fragments, re-transcribes, and queues ANALYZE", async () => {
  const calls: string[] = [];
  const dir = await mkdtemp(join(tmpdir(), "live-fin-"));
  const deps = {
    tempDir: dir,
    ffmpeg: {
      remux: async (i: string, o: string) => {
        calls.push("remux");
        await writeFile(o, await readFile(i));
      },
      probe: async () => ({ durationMs: 24_000, hasAudio: true, videoCodec: null }),
      extractAudio: async () => calls.push("extract"),
    },
    storage: {
      getToFile: async (_k: string, p: string) => {
        await writeFile(p, Buffer.from("webm-fragment-bytes"));
      },
      putFile: async () => calls.push("put"),
      delete: async () => {},
      exists: async () => true,
    },
    videos: {
      get: async () => ({ id: "vidL", storageKey: "videos/vidL/source.webm", durationMs: null, status: "PROBING" }),
      applyProbe: async () => {},
      setStatus: async (_id: string, s: string) => calls.push(`status:${s}`),
      setError: async () => {},
    },
    liveChunks: {
      listForVideo: async () => [
        { id: "c0", videoId: "vidL", index: 0, startMs: 0, storageKey: "videos/vidL/chunks/0.webm", status: "DONE" },
        { id: "c1", videoId: "vidL", index: 1, startMs: 8000, storageKey: "videos/vidL/chunks/1.webm", status: "DONE" },
      ],
    },
    transcription: { transcribe: async () => ({ provider: "fake", language: "en", segments: [] }) },
    transcripts: { save: async () => ({ segmentCount: 0 }) },
    queue: { enqueue: async (i: { kind: string }) => calls.push(`enqueue:${i.kind}`) },
  } as unknown as PipelineDeps;

  const out = await liveFinalizeHandler(jobCtx(deps, "LIVE_FINALIZE", null));
  assert.deepEqual(out, { chunks: 2, usedChunks: 2, segments: 0 });
  assert.ok(calls.includes("remux"));
  assert.ok(calls.includes("put"));
  assert.ok(calls.includes("status:READY"));
  assert.ok(calls.includes("enqueue:ANALYZE"));
});
