import test from "node:test";
import assert from "node:assert/strict";

import type { StorageProvider } from "../src/lib/providers/types.ts";
import type { ClipDb, ClipServiceDeps } from "../src/lib/api/clips.ts";
import { listVideoClips, requestRender } from "../src/lib/api/clips.ts";
import { ApiError } from "../src/lib/api/http.ts";

function fakeStorage(): StorageProvider {
  return {
    name: "fake",
    createUploadUrl: async () => "",
    createDownloadUrl: async (key) => `https://dl.example/${key}`,
    putFile: async () => {},
    getToFile: async () => {},
    delete: async () => {},
    exists: async () => true,
  };
}

function makeDeps(over: Partial<ClipServiceDeps> = {}) {
  const clips = new Map<string, { id: string; videoId: string; aspectRatio: string }>([
    ["clip1", { id: "clip1", videoId: "vidA", aspectRatio: "VERTICAL_9_16" }],
    ["clipX", { id: "clipX", videoId: "vidZ", aspectRatio: "VERTICAL_9_16" }],
  ]);
  const videos = new Map<string, { projectId: string }>([
    ["vidA", { projectId: "proj1" }],
    ["vidZ", { projectId: "someone-else" }],
  ]);
  const renders: Array<Record<string, unknown>> = [];
  const enqueued: Array<{ videoId: string; kind: string; payload?: unknown }> = [];
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];

  const db: ClipDb = {
    clip: {
      findUnique: async ({ where }) => clips.get(where.id) ?? null,
      update: async ({ where, data }) => {
        updates.push({ id: where.id, data });
        Object.assign(clips.get(where.id)!, data);
        return {};
      },
      findMany: async ({ where }) => {
        if (where.videoId !== "vidA") return [];
        return [
          {
            id: "clip1",
            title: "First clip",
            startMs: 1000,
            endMs: 20_000,
            score: 0.82,
            aspectRatio: "VERTICAL_9_16",
            renders: [{ id: "r1", status: "COMPLETED", progress: 1, outputKey: "renders/r1/output.mp4" }],
          },
          {
            id: "clip2",
            title: "Second clip",
            startMs: 30_000,
            endMs: 50_000,
            score: null,
            aspectRatio: "SQUARE_1_1",
            renders: [{ id: "r2", status: "PROCESSING", progress: 0.4, outputKey: null }],
          },
        ];
      },
    },
    video: { findUnique: async ({ where }) => videos.get(where.id) ?? null },
    render: {
      create: async ({ data }) => {
        renders.push(data);
        return { id: `render-${renders.length}` };
      },
    },
  };

  const deps: ClipServiceDeps = {
    db,
    storage: fakeStorage(),
    ensureProject: async () => "proj1",
    enqueue: async (input) => {
      enqueued.push(input);
      return `job-${enqueued.length}`;
    },
    ...over,
  };
  return { deps, renders, enqueued, updates };
}

test("requestRender creates a QUEUED render and enqueues a RENDER job carrying renderId", async () => {
  const { deps, renders, enqueued } = makeDeps();
  const out = await requestRender(deps, "clip1", {});

  assert.deepEqual(out, { renderId: "render-1", jobId: "job-1", status: "QUEUED" });
  assert.equal(renders[0].clipId, "clip1");
  assert.equal(renders[0].quality, "P1080"); // default
  assert.deepEqual(enqueued, [{ videoId: "vidA", kind: "RENDER", payload: { renderId: "render-1" } }]);
});

test("requestRender applies an aspect-ratio override to the clip", async () => {
  const { deps, updates } = makeDeps();
  await requestRender(deps, "clip1", { aspectRatio: "PORTRAIT_4_5", quality: "P720" });
  assert.deepEqual(updates, [{ id: "clip1", data: { aspectRatio: "PORTRAIT_4_5" } }]);
});

test("requestRender rejects an invalid quality", async () => {
  const { deps } = makeDeps();
  await assert.rejects(() => requestRender(deps, "clip1", { quality: "8K" }));
});

test("requestRender 404s for an unknown clip or one in another project", async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    () => requestRender(deps, "nope", {}),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
  await assert.rejects(
    () => requestRender(deps, "clipX", {}),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
});

test("listVideoClips returns each clip with its latest render; download URL only when COMPLETED", async () => {
  const { deps } = makeDeps();
  const list = await listVideoClips(deps, "vidA");

  assert.equal(list.length, 2);
  assert.equal(list[0].render?.status, "COMPLETED");
  assert.equal(list[0].render?.downloadUrl, "https://dl.example/renders/r1/output.mp4");
  assert.equal(list[1].render?.status, "PROCESSING");
  assert.equal(list[1].render?.downloadUrl, null);
});

test("listVideoClips 404s for a video in another project", async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    () => listVideoClips(deps, "vidZ"),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
});
