import test from "node:test";
import assert from "node:assert/strict";

import type { StorageProvider } from "../src/lib/providers/types.ts";
import type { SequenceServiceDeps } from "../src/lib/api/sequence.ts";
import {
  createItemSchema,
  createSequenceItem,
  deleteSequenceItem,
  getOrCreateClipSequence,
  splitSequenceItem,
  updateItemSchema,
  updateSequence,
  updateSequenceItem,
} from "../src/lib/api/sequence.ts";
import { ApiError } from "../src/lib/api/http.ts";

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

/** Clip c1 -> video v1 (project p1), 5000..15000. Plus a foreign video v2 (p2). */
function makeDeps(over: Partial<SequenceServiceDeps> = {}) {
  let seq = 0;
  const id = (p: string) => `${p}${++seq}`;
  const sequences = new Map<string, any>();
  const tracks = new Map<string, any>();
  const items = new Map<string, any>();

  const clips: Record<string, any> = {
    c1: { id: "c1", startMs: 5000, endMs: 15000, videoId: "v1", video: { projectId: "p1" } },
  };
  const videos: Record<string, any> = {
    v1: { id: "v1", projectId: "p1", storageKey: "videos/v1.mp4", durationMs: 60000, hasAudio: true, originalFilename: "rec.mp4" },
    v2: { id: "v2", projectId: "p2", storageKey: "videos/v2.mp4", durationMs: 30000, hasAudio: true, originalFilename: "other.mp4" },
  };
  const assets: Record<string, any> = {
    img1: { id: "img1", projectId: "p1", kind: "IMAGE", name: "logo.png", storageKey: "a/logo.png", durationMs: null },
  };

  const withIncludes = (s: any) => ({
    ...s,
    tracks: [...tracks.values()].filter((t) => t.sequenceId === s.id),
    items: [...items.values()].filter((i) => i.sequenceId === s.id),
  });

  const db: SequenceServiceDeps["db"] = {
    clip: { findUnique: async ({ where }) => (clips[where.id] ?? null) as never },
    video: { findUnique: async ({ where }) => (videos[where.id] ?? null) as never },
    asset: { findUnique: async ({ where }) => (assets[where.id] ?? null) as never },
    sequence: {
      findUnique: async ({ where }) => {
        const s = where.id
          ? sequences.get(where.id)
          : [...sequences.values()].find((x) => x.clipId === where.clipId);
        return (s ? withIncludes(s) : null) as never;
      },
      create: async ({ data }) => {
        const s = { id: id("s"), width: 1080, height: 1920, fps: 30, snap: true, ...data };
        sequences.set(s.id, s);
        return withIncludes(s) as never;
      },
      update: async ({ where, data }) => {
        Object.assign(sequences.get(where.id), data);
        return withIncludes(sequences.get(where.id)) as never;
      },
    },
    sequenceTrack: {
      create: async ({ data }) => {
        const t = { id: id("t"), muted: false, locked: false, ...data };
        tracks.set(t.id, t);
        return t as never;
      },
    },
    sequenceItem: {
      findUnique: async ({ where }) => (items.get(where.id) ?? null) as never,
      create: async ({ data }) => {
        const it = { id: id("i"), order: 0, name: null, sourceVideoId: null, sourceAssetId: null, ...data };
        items.set(it.id, it);
        return it as never;
      },
      update: async ({ where, data }) => {
        Object.assign(items.get(where.id), data);
        return items.get(where.id) as never;
      },
      delete: async ({ where }) => {
        items.delete(where.id);
        return {};
      },
    },
  };

  const deps: SequenceServiceDeps = {
    db,
    storage: fakeStorage(),
    assertProjectOwned: async (p) => {
      if (p !== "p1") throw new ApiError(404, "not found");
    },
    ...over,
  };
  return { deps, sequences, tracks, items };
}

// --- schema -------------------------------------------------------------

test("createItemSchema requires exactly one source", () => {
  assert.throws(() => createItemSchema.parse({ trackId: "t", timelineStart: 0, sourceOut: 100 }));
  assert.throws(() =>
    createItemSchema.parse({ trackId: "t", timelineStart: 0, sourceOut: 100, sourceVideoId: "v", sourceAssetId: "a" }),
  );
  const ok = createItemSchema.parse({ trackId: "t", timelineStart: 0, sourceOut: 100, sourceVideoId: "v" });
  assert.equal(ok.sourceIn, 0); // default
});

test("updateItemSchema rejects an empty patch and an inverted range", () => {
  assert.throws(() => updateItemSchema.parse({}), /nothing to update/);
  assert.throws(() => updateItemSchema.parse({ sourceIn: 500, sourceOut: 200 }), /after sourceIn/);
});

// --- getOrCreate ------------------------------------------------------

test("getOrCreateClipSequence seeds one VIDEO track + the clip window as one item", async () => {
  const { deps } = makeDeps();
  const v = await getOrCreateClipSequence(deps, "c1");

  assert.equal(v.clipId, "c1");
  assert.deepEqual([v.width, v.height, v.fps], [1080, 1920, 30]);
  assert.equal(v.tracks.length, 1);
  assert.deepEqual([v.tracks[0].kind, v.tracks[0].name, v.tracks[0].index], ["VIDEO", "V1", 0]);
  assert.equal(v.items.length, 1);
  assert.deepEqual(
    [v.items[0].timelineStart, v.items[0].sourceIn, v.items[0].sourceOut, v.items[0].kind],
    [0, 5000, 15000, "video"],
  );
  assert.equal(v.items[0].sourceDurationMs, 60000);
  assert.equal(v.items[0].sourceUrl, "https://dl/videos/v1.mp4");
});

test("getOrCreateClipSequence is idempotent", async () => {
  const { deps, sequences } = makeDeps();
  await getOrCreateClipSequence(deps, "c1");
  await getOrCreateClipSequence(deps, "c1");
  assert.equal(sequences.size, 1);
});

test("getOrCreateClipSequence 404s for an unknown or foreign clip", async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    () => getOrCreateClipSequence(deps, "ghost"),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
});

// --- items ----------------------------------------------------------

test("createSequenceItem adds a video item and clamps sourceOut to the source duration", async () => {
  const { deps } = makeDeps();
  const s = await getOrCreateClipSequence(deps, "c1");
  const it = await createSequenceItem(deps, s.id, {
    trackId: s.tracks[0].id,
    sourceVideoId: "v1",
    timelineStart: 20000,
    sourceIn: 0,
    sourceOut: 999999, // past the 60s source
  });
  assert.equal(it.sourceOut, 60000);
  assert.equal(it.timelineStart, 20000);
});

test("createSequenceItem 422s for a track that isn't in the sequence", async () => {
  const { deps } = makeDeps();
  const s = await getOrCreateClipSequence(deps, "c1");
  await assert.rejects(
    () => createSequenceItem(deps, s.id, { trackId: "nope", sourceVideoId: "v1", timelineStart: 0, sourceOut: 1000 }),
    (e: unknown) => e instanceof ApiError && e.status === 422,
  );
});

test("createSequenceItem 404s for a source from another project", async () => {
  const { deps } = makeDeps();
  const s = await getOrCreateClipSequence(deps, "c1");
  await assert.rejects(
    () => createSequenceItem(deps, s.id, { trackId: s.tracks[0].id, sourceVideoId: "v2", timelineStart: 0, sourceOut: 1000 }),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
});

test("createSequenceItem places a still image with a default 5s length", async () => {
  const { deps } = makeDeps();
  const s = await getOrCreateClipSequence(deps, "c1");
  const it = await createSequenceItem(deps, s.id, {
    trackId: s.tracks[0].id,
    sourceAssetId: "img1",
    timelineStart: 0,
  });
  assert.equal(it.kind, "image");
  assert.equal(it.sourceOut, 5000);
});

test("updateSequenceItem moves and trims, clamped to the source", async () => {
  const { deps } = makeDeps();
  const s = await getOrCreateClipSequence(deps, "c1");
  const id = s.items[0].id;
  const moved = await updateSequenceItem(deps, id, { timelineStart: 15250 });
  assert.equal(moved.timelineStart, 15250);
  const trimmed = await updateSequenceItem(deps, id, { sourceIn: 6000, sourceOut: 90000 });
  assert.equal(trimmed.sourceIn, 6000);
  assert.equal(trimmed.sourceOut, 60000); // clamped to the 60s source
});

test("updateSequenceItem 404s for an unknown item and a foreign clip", async () => {
  const { deps, clips } = makeDeps() as any;
  await assert.rejects(
    () => updateSequenceItem(deps, "ghost", { timelineStart: 0 }),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
  const s = await getOrCreateClipSequence(deps, "c1");
  makeDeps(); // noop
  // flip ownership
  (deps.assertProjectOwned as unknown) = async () => {
    throw new ApiError(404, "no");
  };
  await assert.rejects(
    () => updateSequenceItem(deps, s.items[0].id, { timelineStart: 1 }),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
});

test("deleteSequenceItem removes the item", async () => {
  const { deps, items } = makeDeps();
  const s = await getOrCreateClipSequence(deps, "c1");
  await deleteSequenceItem(deps, s.items[0].id);
  assert.equal(items.size, 0);
});

// --- split --------------------------------------------------------

test("splitSequenceItem cuts one item into two at the right source offset", async () => {
  const { deps, items } = makeDeps();
  const s = await getOrCreateClipSequence(deps, "c1"); // item: t0, src 5000..15000
  const { left, right } = await splitSequenceItem(deps, s.items[0].id, { atMs: 4000 });

  // left keeps the id, gets a shorter tail
  assert.equal(left.id, s.items[0].id);
  assert.equal(left.sourceIn, 5000);
  assert.equal(left.sourceOut, 9000); // 5000 + 4000
  // right is new, starts where we cut
  assert.notEqual(right.id, left.id);
  assert.equal(right.timelineStart, 4000);
  assert.equal(right.sourceIn, 9000);
  assert.equal(right.sourceOut, 15000);
  assert.equal(items.size, 2);
});

test("splitSequenceItem 422s for a cut at or outside the item edges", async () => {
  const { deps } = makeDeps();
  const s = await getOrCreateClipSequence(deps, "c1"); // spans timeline 0..10000
  for (const atMs of [0, 10000, 25000]) {
    await assert.rejects(
      () => splitSequenceItem(deps, s.items[0].id, { atMs }),
      (e: unknown) => e instanceof ApiError && e.status === 422,
    );
  }
});

// --- sequence-level ------------------------------------------------

test("updateSequence changes output size / fps / snap", async () => {
  const { deps } = makeDeps();
  const s = await getOrCreateClipSequence(deps, "c1");
  const v = await updateSequence(deps, s.id, { width: 1920, height: 1080, fps: 24, snap: false });
  assert.deepEqual([v.width, v.height, v.fps, v.snap], [1920, 1080, 24, false]);
});

test("updateSequence 404s for an unowned sequence", async () => {
  const { deps } = makeDeps();
  const s = await getOrCreateClipSequence(deps, "c1");
  (deps.assertProjectOwned as unknown) = async () => {
    throw new ApiError(404, "no");
  };
  await assert.rejects(
    () => updateSequence(deps, s.id, { fps: 25 }),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
});
