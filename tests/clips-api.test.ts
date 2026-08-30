import test from "node:test";
import assert from "node:assert/strict";

import type { StorageProvider } from "../src/lib/providers/types.ts";
import type { ClipDb, ClipServiceDeps } from "../src/lib/api/clips.ts";
import {
  createClipFromRange,
  createManualClip,
  deleteCaptionConfig,
  deleteClip,
  listVideoClips,
  requestClipThumbnail,
  requestRender,
  updateClip,
  upsertCaptionConfig,
} from "../src/lib/api/clips.ts";
import { ApiError } from "../src/lib/api/http.ts";
import { extractFeatures } from "../src/lib/learning/features.ts";
import { buildProfile } from "../src/lib/learning/profile.ts";

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

interface ClipStore {
  id: string;
  videoId: string;
  startMs: number;
  endMs: number;
  aspectRatio: string;
}

function makeDeps(
  over: Partial<ClipServiceDeps> = {},
  inFlightRender: { id: string; status: string } | null = null,
) {
  const clips = new Map<string, ClipStore>([
    ["clip1", { id: "clip1", videoId: "vidA", startMs: 5_000, endMs: 25_000, aspectRatio: "VERTICAL_9_16" }],
    ["clipX", { id: "clipX", videoId: "vidZ", startMs: 0, endMs: 1_000, aspectRatio: "VERTICAL_9_16" }],
  ]);
  const videos = new Map<string, { projectId: string; durationMs: number | null }>([
    ["vidA", { projectId: "proj1", durationMs: 120_000 }],
    ["vidZ", { projectId: "someone-else", durationMs: 60_000 }],
  ]);
  const segments = [
    { startMs: 0, endMs: 20_000 },
    { startMs: 20_000, endMs: 45_000 },
    { startMs: 45_000, endMs: 70_000 },
  ];
  const renders: Array<Record<string, unknown>> = [];
  const enqueued: Array<{ videoId: string; kind: string; payload?: unknown }> = [];
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const created: Array<Record<string, unknown>> = [];
  const deleted: string[] = [];
  const captionConfigs = new Map<string, Record<string, unknown>>();
  const captionOps: Array<{ op: "upsert" | "deleteMany"; clipId: string }> = [];

  const db: ClipDb = {
    clip: {
      findUnique: async ({ where }) => clips.get(where.id) ?? null,
      update: async ({ where, data }) => {
        updates.push({ id: where.id, data });
        Object.assign(clips.get(where.id) ?? {}, data);
        return {};
      },
      create: async ({ data }) => {
        created.push(data);
        return { id: `clip-${created.length}` };
      },
      delete: async ({ where }) => {
        deleted.push(where.id);
        clips.delete(where.id);
        return {};
      },
      findMany: async ({ where }) => {
        if (where.videoId !== "vidA") return [];
        return [
          {
            id: "clip1",
            origin: "AI_SUGGESTED",
            title: "First clip",
            startMs: 5_000,
            endMs: 25_000,
            score: 0.82,
            aspectRatio: "VERTICAL_9_16",
            focalX: 0.5,
            focalY: 0.4,
            focusTrackJson: null,
            censorEnabled: false,
            censorSensitivity: "MEDIUM",
            censorCaptionMode: "FULL",
            censorAudioMode: "BEEP",
            censorReplacement: null,
            censorAllowList: [],
            censorDenyList: [],
            accepted: false,
            savedToProjectId: null,
            caption: "A punchy one-liner for socials",
            hook: "Wait for the twist at the end",
            socialTitle: "The moment nobody saw coming",
            hashtags: ["#shorts", "#storytime"],
            reason: "Self-contained beat with a clear payoff",
            thumbnailKey: "clips/clip1/thumb.jpg",
            subtitleConfig: {
              preset: "CLASSIC",
              animation: "POP",
              fontFamily: "Inter",
              fontSizePx: 64,
              fontWeight: 700,
              textColor: "#FFFFFF",
              highlightColor: "#FFE600",
              outlineColor: "#000000",
              outlineWidthPx: 6,
              backgroundColor: null,
              alignment: "center",
              positionY: 0.78,
              maxLines: 2,
              maxWordsPerCue: 7,
              uppercase: false,
              styleJson: null,
              wordRulesJson: null,
            },
            renders: [
              {
                id: "r1",
                status: "COMPLETED",
                progress: 1,
                outputKey: "renders/r1/output.mp4",
                quality: "P1080",
                sizeBytes: 4_200_000n,
                durationMs: 26_600,
                startedAt: null,
              },
            ],
          },
        ];
      },
    },
    video: { findUnique: async ({ where }) => videos.get(where.id) ?? null },
    transcriptSegment: { findMany: async () => segments },
    render: {
      findFirst: async () => inFlightRender,
      create: async ({ data }) => {
        renders.push(data);
        return { id: `render-${renders.length}` };
      },
    },
    subtitleConfig: {
      upsert: async ({ where, create, update }) => {
        captionOps.push({ op: "upsert", clipId: where.clipId });
        const existing = captionConfigs.get(where.clipId);
        const next = existing ? { ...existing, ...update } : { ...create };
        captionConfigs.set(where.clipId, next);
        return next;
      },
      deleteMany: async ({ where }) => {
        captionOps.push({ op: "deleteMany", clipId: where.clipId });
        const had = captionConfigs.delete(where.clipId);
        return { count: had ? 1 : 0 };
      },
    },
  };

  const deps: ClipServiceDeps = {
    db,
    storage: fakeStorage(),
    assertProjectOwned: async (projectId: string) => {
      if (projectId !== "proj1") throw new ApiError(404, "not found");
    },
    enqueue: async (input) => {
      enqueued.push(input);
      return `job-${enqueued.length}`;
    },
    ...over,
  };
  return { deps, renders, enqueued, updates, created, deleted, clips, captionConfigs, captionOps };
}

// --- requestRender ------------------------------------------------

test("requestRender creates a QUEUED render and enqueues a RENDER job carrying renderId", async () => {
  const { deps, renders, enqueued } = makeDeps();
  const out = await requestRender(deps, "clip1", {});
  assert.deepEqual(out, { renderId: "render-1", jobId: "job-1", status: "QUEUED" });
  assert.equal(renders[0].quality, "P1080");
  assert.deepEqual(enqueued, [{ videoId: "vidA", kind: "RENDER", payload: { renderId: "render-1" } }]);
});

test("requestRender returns the in-flight render instead of stacking a duplicate", async () => {
  const { deps, renders, enqueued } = makeDeps({}, { id: "existing", status: "PROCESSING" });
  const out = await requestRender(deps, "clip1", {});
  assert.deepEqual(out, {
    renderId: "existing",
    jobId: null,
    status: "PROCESSING",
    alreadyRunning: true,
  });
  assert.equal(renders.length, 0);
  assert.equal(enqueued.length, 0);
});

test("requestRender 404s for an unknown clip or one in another project", async () => {
  const { deps } = makeDeps();
  await assert.rejects(() => requestRender(deps, "nope", {}), (e: unknown) => e instanceof ApiError && e.status === 404);
  await assert.rejects(() => requestRender(deps, "clipX", {}), (e: unknown) => e instanceof ApiError && e.status === 404);
});

test("requestClipThumbnail enqueues a THUMBNAIL job scoped to the clip", async () => {
  const { deps, enqueued } = makeDeps();
  const out = await requestClipThumbnail(deps, "clip1");
  assert.deepEqual(out, { jobId: "job-1", status: "QUEUED" });
  assert.deepEqual(enqueued, [{ videoId: "vidA", kind: "THUMBNAIL", payload: { clipId: "clip1" } }]);
  await assert.rejects(
    () => requestClipThumbnail(deps, "clipX"),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
});

// --- updateClip --------------------------------------------------

test("updateClip persists only the provided fields", async () => {
  const { deps, updates } = makeDeps();
  const out = await updateClip(deps, "clip1", { title: "Renamed", accepted: true });
  assert.deepEqual(updates, [{ id: "clip1", data: { title: "Renamed", accepted: true } }]);
  assert.equal(out.title, "Renamed");
});

test("updateClip rejects a range where end is not after start (merged with current)", async () => {
  const { deps } = makeDeps();
  // current start 5000; new end 4000 -> invalid
  await assert.rejects(
    () => updateClip(deps, "clip1", { endMs: 4_000 }),
    (e: unknown) => e instanceof ApiError && e.status === 400,
  );
});

test("updateClip rejects unknown fields and out-of-range focal points", async () => {
  const { deps } = makeDeps();
  await assert.rejects(() => updateClip(deps, "clip1", { bogus: 1 }));
  await assert.rejects(() => updateClip(deps, "clip1", { focalX: 1.5 }));
});

test("updateClip 404s for a clip in another project", async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    () => updateClip(deps, "clipX", { title: "x" }),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
});

// --- deleteClip --------------------------------------------------

test("deleteClip removes an owned clip", async () => {
  const { deps, deleted } = makeDeps();
  const out = await deleteClip(deps, "clip1");
  assert.deepEqual(out, { id: "clip1", deleted: true });
  assert.deepEqual(deleted, ["clip1"]);
});

test("deleteClip 404s for a clip in another project", async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    () => deleteClip(deps, "clipX"),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
});

// --- createManualClip -----------------------------------------

test("a learned profile fills in the defaults a new clip starts with", async () => {
  // A settled profile: every example is 9:16 with captions on, in the same style.
  const example = extractFeatures({
    startMs: 0,
    endMs: 20_000,
    aspectRatio: "SQUARE_1_1",
    overlays: [],
    captions: {
      enabled: true,
      templateId: "viral-pop-yellow",
      animation: "POP",
      fontFamily: "Archivo Black",
      fontSizePx: 72,
      positionY: 0.8,
    },
  });
  const profile = buildProfile(
    "PODCAST",
    Array.from({ length: 15 }, () => ({ features: example })),
  );

  const { deps, created, captionConfigs } = makeDeps({
    loadProfile: async () => profile,
  });
  const out = await createClipFromRange(deps, "vidA", { startMs: 25_000, endMs: 40_000 });

  assert.equal(created[0].aspectRatio, "SQUARE_1_1", "learned framing was applied");
  // Captions are a separate row, created because the profile says they are usual.
  const caps = captionConfigs.get(out.id);
  assert.ok(caps, "a caption config was created");
  assert.equal(caps.animation, "POP");
  assert.equal(caps.fontFamily, "Archivo Black");
  assert.equal(caps.fontSizePx, 72);
  assert.equal(caps.positionY, 0.8);
  assert.match(String(caps.styleJson), /viral-pop-yellow/);
  assert.deepEqual(out.appliedDefaults, ["aspect ratio", "captions"]);
});

test("with no profile a new clip keeps the global defaults", async () => {
  const { deps, created, captionConfigs } = makeDeps();
  const out = await createClipFromRange(deps, "vidA", { startMs: 25_000, endMs: 40_000 });
  assert.equal(created[0].aspectRatio, undefined, "nothing was forced");
  assert.equal(captionConfigs.get(out.id), undefined, "no captions were assumed");
  assert.deepEqual(out.appliedDefaults, []);
});

test("a profile that fails to load never blocks clip creation", async () => {
  const { deps } = makeDeps({
    loadProfile: async () => {
      throw new Error("profile store is down");
    },
  });
  const out = await createClipFromRange(deps, "vidA", { startMs: 25_000, endMs: 40_000 });
  assert.ok(out.id, "the clip was still created");
  assert.deepEqual(out.appliedDefaults, []);
});

test("an accepted highlight carries its title and metadata onto the clip", async () => {
  const { deps, created } = makeDeps();
  await createClipFromRange(deps, "vidA", {
    startMs: 25_000,
    endMs: 40_000,
    title: "The moment",
    hook: "wait for it",
    caption: "cap",
    socialTitle: "social",
    hashtags: ["#a"],
    reason: "scored well",
    score: 0.82,
    origin: "AI_SUGGESTED",
  });
  assert.equal(created[0].origin, "AI_SUGGESTED");
  assert.equal(created[0].title, "The moment");
  assert.equal(created[0].hook, "wait for it");
  assert.equal(created[0].score, 0.82);
  assert.deepEqual(created[0].hashtags, ["#a"]);
});

test("createManualClip snaps the window to sentence boundaries and marks it USER_CREATED", async () => {
  const { deps, created } = makeDeps();
  // window 25000..40000 falls inside segment 1 (20000..45000)
  const out = await createManualClip(deps, "vidA", { startMs: 25_000, endMs: 40_000, title: "Manual" });

  assert.equal(created.length, 1);
  assert.equal(created[0].origin, "USER_CREATED");
  assert.equal(created[0].title, "Manual");
  // snapped outward to the segment, then padded by the snap defaults
  assert.equal(out.startMs, 20_000 - 250);
  assert.equal(out.endMs, 45_000 + 400);
});

test("createManualClip rejects an inverted range and non-owned videos", async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    () => createManualClip(deps, "vidA", { startMs: 10, endMs: 5 }),
    (e: unknown) => e instanceof ApiError && e.status === 400,
  );
  await assert.rejects(
    () => createManualClip(deps, "vidZ", { startMs: 0, endMs: 5_000 }),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
});

// --- listVideoClips -----------------------------------------

test("listVideoClips returns editable fields, the caption config, and a download URL only when COMPLETED", async () => {
  const { deps } = makeDeps();
  const list = await listVideoClips(deps, "vidA");
  assert.equal(list.length, 1);
  assert.equal(list[0].origin, "AI_SUGGESTED");
  assert.equal(list[0].focalX, 0.5);
  assert.equal(list[0].accepted, false);
  assert.equal(list[0].captions?.animation, "POP");
  assert.equal(list[0].thumbnailUrl, "https://dl.example/clips/clip1/thumb.jpg");
  assert.equal(list[0].render?.downloadUrl, "https://dl.example/renders/r1/output.mp4");
});

// --- caption config -----------------------------------------

test("upsertCaptionConfig writes only the provided fields for an owned clip", async () => {
  const { deps, captionConfigs, captionOps } = makeDeps();
  const saved = await upsertCaptionConfig(deps, "clip1", { animation: "KARAOKE", uppercase: true });
  assert.deepEqual(captionOps, [{ op: "upsert", clipId: "clip1" }]);
  assert.equal(captionConfigs.get("clip1")?.clipId, "clip1");
  assert.equal((saved as { animation: string }).animation, "KARAOKE");
});

test("upsertCaptionConfig rejects a bad hex colour, an unknown animation, and unknown fields", async () => {
  const { deps } = makeDeps();
  await assert.rejects(() => upsertCaptionConfig(deps, "clip1", { textColor: "red" }));
  await assert.rejects(() => upsertCaptionConfig(deps, "clip1", { animation: "SPARKLE" }));
  await assert.rejects(() => upsertCaptionConfig(deps, "clip1", { bogus: 1 }));
});

test("caption config actions 404 for a clip in another project", async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    () => upsertCaptionConfig(deps, "clipX", { animation: "POP" }),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
  await assert.rejects(
    () => deleteCaptionConfig(deps, "clipX"),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
});

test("deleteCaptionConfig reports whether a config was removed", async () => {
  const { deps } = makeDeps();
  assert.deepEqual(await deleteCaptionConfig(deps, "clip1"), { clipId: "clip1", removed: false });
  await upsertCaptionConfig(deps, "clip1", { animation: "POP" });
  assert.deepEqual(await deleteCaptionConfig(deps, "clip1"), { clipId: "clip1", removed: true });
});
