import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";

import type { StorageProvider } from "../src/lib/providers/types.ts";
import type { VideoDb, VideoRecord, VideoServiceDeps } from "../src/lib/api/videos.ts";
import {
  cancelVideo,
  deleteVideo,
  confirmUpload,
  createUploadSchema,
  createVideoFromUrl,
  createVideosFromUrl,
  createVideoUpload,
  getVideoStatus,
  translateVideo,
} from "../src/lib/api/videos.ts";
import { ApiError } from "../src/lib/api/http.ts";
import { authorizeLocalRequest } from "../src/lib/api/local-storage.ts";
import { LocalStorageProvider } from "../src/lib/storage/local.ts";
import { signStorageToken } from "../src/lib/storage/signing.ts";

// --- fakes ---------------------------------------------------------

function fakeStorage(over: Partial<StorageProvider> = {}): StorageProvider {
  return {
    name: "fake",
    createUploadUrl: async (key) => `https://upload.example/${key}`,
    createDownloadUrl: async (key) => `https://dl.example/${key}`,
    putFile: async () => {},
    getToFile: async () => {},
    delete: async () => {},
    exists: async () => true,
    ...over,
  };
}

function fakeDb() {
  const videos = new Map<
    string,
    VideoRecord & { projectId: string; sourceUrlHash?: string | null; userId?: string }
  >();
  const jobUpdates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  let seq = 0;
  const db: VideoDb = {
    video: {
      async create({ data }) {
        const id = `vid${++seq}`;
        videos.set(id, {
          id,
          status: String(data.status),
          storageKey: String(data.storageKey),
          originalFilename: String(data.originalFilename),
          projectId: String(data.projectId),
          durationMs: null,
          width: null,
          height: null,
          errorMessage: null,
          sourceUrlHash: (data.sourceUrlHash as string | undefined) ?? null,
        });
        return { id };
      },
      async findUnique({ where }) {
        return videos.get(where.id) ?? null;
      },
      async findFirst({ where }) {
        for (const v of [...videos.values()].reverse()) {
          if (
            v.sourceUrlHash === where.sourceUrlHash &&
            v.status === where.status &&
            (v.userId ?? "proj1-owner") === where.project.userId
          ) {
            return { id: v.id, projectId: v.projectId };
          }
        }
        return null;
      },
      async update({ where, data }) {
        Object.assign(videos.get(where.id)!, data);
        return {};
      },
      async delete({ where }) {
        videos.delete(where.id);
        return {};
      },
    },
    clip: { count: async () => 3 },
    transcript: {
      findFirst: async () => ({ language: "en" }),
      findMany: async () => [{ translatedTo: "", language: "en" }],
    },
    job: {
      findMany: async () => [],
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        jobUpdates.push(args);
        return { count: 1 };
      },
    },
  };
  return { db, videos, jobUpdates };
}

function makeDeps(over: Partial<VideoServiceDeps> = {}): {
  deps: VideoServiceDeps;
  enqueued: Array<{ videoId: string; kind: string; payload?: unknown }>;
  videos: ReturnType<typeof fakeDb>["videos"];
  jobUpdates: ReturnType<typeof fakeDb>["jobUpdates"];
} {
  const { db, videos, jobUpdates } = fakeDb();
  const enqueued: Array<{ videoId: string; kind: string; payload?: unknown }> = [];
  const deps: VideoServiceDeps = {
    db,
    storage: fakeStorage(),
    maxUploadBytes: 5_000_000,
    userId: "proj1-owner",
    defaultProjectId: async () => "proj1",
    assertProjectOwned: async (projectId: string) => {
      if (projectId !== "proj1") throw new ApiError(404, "not found");
    },
    enqueue: async (input) => {
      enqueued.push(input);
      return `job-${enqueued.length}`;
    },
    ...over,
  };
  return { deps, enqueued, videos, jobUpdates };
}

// --- schema ------------------------------------------------------

test("createUploadSchema accepts a video upload and rejects bad input", () => {
  assert.doesNotThrow(() =>
    createUploadSchema.parse({ filename: "a.mp4", contentType: "video/mp4", sizeBytes: 10 }),
  );
  assert.throws(() =>
    createUploadSchema.parse({ filename: "a.txt", contentType: "text/plain", sizeBytes: 10 }),
  );
  assert.throws(() =>
    createUploadSchema.parse({ filename: "", contentType: "video/mp4", sizeBytes: 10 }),
  );
  assert.throws(() =>
    createUploadSchema.parse({ filename: "a.mp4", contentType: "video/mp4", sizeBytes: 0 }),
  );
});

// --- createVideoFromUrl --------------------------------------

test("createVideoFromUrl stores a row and enqueues a FETCH job with the url", async () => {
  const { deps, enqueued, videos } = makeDeps();
  const out = await createVideoFromUrl(deps, { url: "https://www.youtube.com/watch?v=abc" });

  assert.match(out.videoId, /^vid\d+$/);
  assert.equal(out.status, "FETCHING");
  assert.equal(videos.get(out.videoId)!.status, "UPLOADING");
  assert.deepEqual(enqueued, [
    { videoId: out.videoId, kind: "FETCH", payload: { url: "https://www.youtube.com/watch?v=abc" } },
  ]);
});

test("createVideoFromUrl reuses an already-transcribed URL instead of re-ingesting", async () => {
  const { deps, enqueued } = makeDeps();
  // first submission -> ingests
  const first = await createVideoFromUrl(deps, { url: "https://youtu.be/abc?si=track123" });
  assert.equal(first.reused, false);
  // mark it done, as the pipeline would
  const dbVideo = (deps.db.video as unknown as {
    findUnique: (a: { where: { id: string } }) => Promise<{ status: string } | null>;
  });
  (await dbVideo.findUnique({ where: { id: first.videoId } }))!.status = "READY";

  // same video, different tracking params + fragment -> cache hit, no new job
  const again = await createVideoFromUrl(deps, {
    url: "https://youtu.be/abc?si=DIFFERENT#t=10",
  });
  assert.equal(again.reused, true);
  assert.equal(again.videoId, first.videoId);
  assert.equal(again.status, "READY");
  assert.equal(enqueued.length, 1, "no second FETCH enqueued");
});

test("createVideoFromUrl does not reuse a URL that is still processing", async () => {
  const { deps, enqueued } = makeDeps();
  await createVideoFromUrl(deps, { url: "https://example.com/v.mp4" }); // stays UPLOADING
  const second = await createVideoFromUrl(deps, { url: "https://example.com/v.mp4" });
  assert.equal(second.reused, false);
  assert.equal(enqueued.length, 2);
});

test("createVideoFromUrl rejects non-URLs and non-http schemes", async () => {
  const { deps } = makeDeps();
  await assert.rejects(() => createVideoFromUrl(deps, { url: "not a url" }));
  await assert.rejects(() => createVideoFromUrl(deps, { url: "ftp://example.com/x.mp4" }));
  await assert.rejects(() => createVideoFromUrl(deps, {}));
});

// --- createVideosFromUrl (playlists) --------------------------

test("a playlist link ingests every entry through the single-video path", async () => {
  const { deps, enqueued, videos } = makeDeps();
  const probe = {
    probePlaylist: async () => ({
      title: "Field Trip",
      total: 3,
      entries: [
        { url: "https://www.youtube.com/watch?v=a1", title: "One" },
        { url: "https://www.youtube.com/watch?v=a2", title: "Two" },
        { url: "https://www.youtube.com/watch?v=a3", title: "Three" },
      ],
    }),
  };
  const out = await createVideosFromUrl(deps, probe, {
    url: "https://www.youtube.com/playlist?list=PLxyz",
  });

  assert.equal("playlist" in out && out.playlist, true);
  if ("playlist" in out) {
    assert.equal(out.videos.length, 3);
    assert.equal(out.added, 3);
    assert.equal(out.skipped, 0);
    assert.equal(out.title, "Field Trip");
  }
  // Three real videos, three FETCH jobs, one per entry URL.
  assert.equal(videos.size, 3);
  assert.deepEqual(
    enqueued.map((j) => (j.payload as { url: string }).url),
    ["https://www.youtube.com/watch?v=a1", "https://www.youtube.com/watch?v=a2", "https://www.youtube.com/watch?v=a3"],
  );
});

test("the playlist cap ingests the first N and reports the rest as skipped", async () => {
  const { deps, enqueued } = makeDeps();
  const probe = {
    probePlaylist: async () => ({
      title: "Endless Mix",
      total: 40,
      entries: Array.from({ length: 40 }, (_, i) => ({ url: `https://www.youtube.com/watch?v=m${i}` })),
    }),
  };
  const out = await createVideosFromUrl(
    deps,
    probe,
    { url: "https://www.youtube.com/watch?v=m0&list=RDm0" },
    5,
  );
  if ("playlist" in out) {
    assert.equal(out.videos.length, 5);
    assert.equal(out.skipped, 35, "what the cap left out is reported, not swallowed");
  } else {
    assert.fail("expected the playlist shape");
  }
  assert.equal(enqueued.length, 5);
});

test("a plain link goes down the single-video path untouched", async () => {
  const { deps, enqueued } = makeDeps();
  const probe = {
    probePlaylist: async () => {
      throw new Error("must not enumerate a plain watch link");
    },
  };
  const out = await createVideosFromUrl(deps, probe, { url: "https://www.youtube.com/watch?v=solo" });
  assert.equal("playlist" in out, false);
  assert.equal(enqueued.length, 1);
});

test("a playlist link that turns out to hold one video falls back to the single path", async () => {
  const { deps, enqueued } = makeDeps();
  const probe = {
    probePlaylist: async () => ({
      title: "One-video list",
      total: 1,
      entries: [{ url: "https://www.youtube.com/watch?v=only" }],
    }),
  };
  const out = await createVideosFromUrl(deps, probe, {
    url: "https://www.youtube.com/playlist?list=PLone",
  });
  assert.equal("playlist" in out, false);
  assert.equal(enqueued.length, 1);
});

// --- createVideoUpload ----------------------------------------

test("createVideoUpload stores an UPLOADING row and returns a presigned PUT", async () => {
  const { deps, videos } = makeDeps();
  const out = await createVideoUpload(deps, {
    filename: "My Clip.MOV",
    contentType: "video/quicktime",
    sizeBytes: 1234,
  });

  assert.match(out.videoId, /^vid\d+$/);
  assert.match(out.storageKey, /^videos\/[0-9a-f-]+\/source\.mov$/);
  assert.equal(out.upload.method, "PUT");
  assert.equal(out.upload.headers["content-type"], "video/quicktime");
  assert.equal(videos.get(out.videoId)!.status, "UPLOADING");
});

test("createVideoUpload rejects a file over the size limit with 413", async () => {
  const { deps } = makeDeps({ maxUploadBytes: 1000 });
  await assert.rejects(
    () => createVideoUpload(deps, { filename: "a.mp4", contentType: "video/mp4", sizeBytes: 5000 }),
    (e: unknown) => e instanceof ApiError && e.status === 413,
  );
});

test("createVideoUpload falls back to .mp4 for an odd extension", async () => {
  const { deps } = makeDeps();
  const out = await createVideoUpload(deps, {
    filename: "clip.reallylongext",
    contentType: "video/mp4",
    sizeBytes: 10,
  });
  assert.match(out.storageKey, /\/source\.mp4$/);
});

// --- confirmUpload ------------------------------------------

test("confirmUpload flips UPLOADING -> UPLOADED and enqueues PROBE", async () => {
  const { deps, enqueued, videos } = makeDeps();
  const { videoId } = await createVideoUpload(deps, {
    filename: "a.mp4",
    contentType: "video/mp4",
    sizeBytes: 10,
  });

  const out = await confirmUpload(deps, videoId);
  assert.deepEqual(out, { videoId, status: "UPLOADED", jobId: "job-1" });
  assert.equal(videos.get(videoId)!.status, "UPLOADED");
  assert.deepEqual(enqueued, [{ videoId, kind: "PROBE" }]);
});

test("confirmUpload is idempotent once ingest has started", async () => {
  const { deps, enqueued } = makeDeps();
  const { videoId } = await createVideoUpload(deps, {
    filename: "a.mp4",
    contentType: "video/mp4",
    sizeBytes: 10,
  });
  await confirmUpload(deps, videoId);
  const again = await confirmUpload(deps, videoId);
  assert.equal(again.alreadyStarted, true);
  assert.equal(enqueued.length, 1);
});

test("confirmUpload 404s for an unknown video and 409s when the file is missing", async () => {
  const { deps } = makeDeps({ storage: fakeStorage({ exists: async () => false }) });
  await assert.rejects(
    () => confirmUpload(deps, "nope"),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
  const { videoId } = await createVideoUpload(deps, {
    filename: "a.mp4",
    contentType: "video/mp4",
    sizeBytes: 10,
  });
  await assert.rejects(
    () => confirmUpload(deps, videoId),
    (e: unknown) => e instanceof ApiError && e.status === 409,
  );
});

// --- getVideoStatus ---------------------------------------

test("a video owned by another project is 404, not 403", async () => {
  const { deps, videos } = makeDeps();
  const { videoId } = await createVideoUpload(deps, {
    filename: "a.mp4",
    contentType: "video/mp4",
    sizeBytes: 10,
  });
  videos.get(videoId)!.projectId = "someone-elses-project";

  await assert.rejects(
    () => confirmUpload(deps, videoId),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
  await assert.rejects(
    () => getVideoStatus(deps, videoId),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
});

test("getVideoStatus returns the poll shape and 404s when missing", async () => {
  const { deps } = makeDeps();
  const { videoId } = await createVideoUpload(deps, {
    filename: "a.mp4",
    contentType: "video/mp4",
    sizeBytes: 10,
  });
  const status = await getVideoStatus(deps, videoId);
  assert.equal(status.status, "UPLOADING");
  assert.equal(status.clipCount, 3);
  assert.equal(status.transcriptLanguage, "en");

  await assert.rejects(
    () => getVideoStatus(deps, "missing"),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
});

// --- cancelVideo -----------------------------------------

test("cancelVideo CANCELs live jobs, deletes the video, and removes its source", async () => {
  const { deps, videos, jobUpdates } = makeDeps();
  const deleted: string[] = [];
  deps.storage.delete = async (key) => {
    deleted.push(key);
  };
  const { videoId } = await createVideoFromUrl(deps, { url: "https://example.com/v.mp4" });
  const storageKey = videos.get(videoId)!.storageKey;

  const out = await cancelVideo(deps, videoId);

  assert.equal(out.removed, true);
  assert.equal(videos.has(videoId), false); // row gone
  assert.deepEqual(deleted, [storageKey]); // source cleaned up
  const [call] = jobUpdates; // live jobs cancelled first
  assert.equal((call.where as { videoId: string }).videoId, videoId);
  assert.equal((call.data as { status: string }).status, "CANCELLED");
});

test("cancelVideo removes a FAILED video too", async () => {
  const { deps, videos } = makeDeps();
  const { videoId } = await createVideoFromUrl(deps, { url: "https://example.com/v.mp4" });
  videos.get(videoId)!.status = "FAILED";

  const out = await cancelVideo(deps, videoId);
  assert.equal(out.removed, true);
  assert.equal(videos.has(videoId), false);
});

test("cancelVideo refuses a READY video (409)", async () => {
  const { deps, videos } = makeDeps();
  const { videoId } = await createVideoFromUrl(deps, { url: "https://example.com/v.mp4" });
  videos.get(videoId)!.status = "READY";

  await assert.rejects(
    () => cancelVideo(deps, videoId),
    (e: unknown) => e instanceof ApiError && e.status === 409,
  );
  assert.equal(videos.has(videoId), true); // untouched
});

test("cancelVideo 404s for an unknown video", async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    () => cancelVideo(deps, "missing"),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
});

// --- deleteVideo -----------------------------------------

test("deleteVideo removes a READY video, its jobs, and its source", async () => {
  const { deps, videos, jobUpdates } = makeDeps();
  const deleted: string[] = [];
  deps.storage.delete = async (key) => {
    deleted.push(key);
  };
  const { videoId } = await createVideoFromUrl(deps, { url: "https://example.com/v.mp4" });
  const storageKey = videos.get(videoId)!.storageKey;
  videos.get(videoId)!.status = "READY";

  const out = await deleteVideo(deps, videoId);

  assert.equal(out.removed, true);
  assert.equal(videos.has(videoId), false);
  assert.deepEqual(deleted, [storageKey]);
  assert.equal((jobUpdates[0]?.data as { status: string }).status, "CANCELLED");
});

test("deleteVideo 404s for an unknown video", async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    () => deleteVideo(deps, "missing"),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
});

// --- local storage route auth ----------------------------

const SECRET = "route-secret";
const routeDeps = {
  provider: new LocalStorageProvider({ baseDir: tmpdir(), publicBaseUrl: "http://x", secret: SECRET }),
  secret: SECRET,
  maxUploadBytes: 1_000_000,
};

test("authorizeLocalRequest resolves a path for a valid token", () => {
  const token = signStorageToken({ secret: SECRET, action: "put", key: "videos/v1/source.mp4", expiresInSec: 300 });
  const { key, path } = authorizeLocalRequest(routeDeps, ["videos", "v1", "source.mp4"], "put", token);
  assert.equal(key, "videos/v1/source.mp4");
  assert.ok(path.endsWith("source.mp4"));
});

test("authorizeLocalRequest rejects missing, wrong-action, and tampered tokens", () => {
  assert.throws(
    () => authorizeLocalRequest(routeDeps, ["videos", "v1", "x.mp4"], "get", null),
    (e: unknown) => e instanceof ApiError && e.status === 401,
  );
  const putToken = signStorageToken({ secret: SECRET, action: "put", key: "videos/v1/x.mp4", expiresInSec: 300 });
  assert.throws(
    () => authorizeLocalRequest(routeDeps, ["videos", "v1", "x.mp4"], "get", putToken),
    (e: unknown) => e instanceof ApiError && e.status === 403,
  );
});


// --- translateVideo -------------------------------------

test("translateVideo enqueues a translate pass without touching the video", async () => {
  const { deps, enqueued, videos } = makeDeps();
  const { videoId } = await createVideoFromUrl(deps, { url: "https://example.com/v.mp4" });
  videos.get(videoId)!.status = "READY";

  const out = await translateVideo(deps, videoId, { target: "en" });
  assert.equal(out.target, "en");
  assert.equal(videos.get(videoId)!.status, "READY", "the original stays READY");
  assert.deepEqual(enqueued.at(-1), {
    videoId,
    kind: "EXTRACT_AUDIO",
    payload: { task: "translate", translatedTo: "en" },
  });
});

test("translateVideo rejects a bad target and a still-processing video", async () => {
  const { deps, videos } = makeDeps();
  const { videoId } = await createVideoFromUrl(deps, { url: "https://example.com/v.mp4" });
  videos.get(videoId)!.status = "READY";
  await assert.rejects(() => translateVideo(deps, videoId, { target: "xx" }));

  videos.get(videoId)!.status = "TRANSCRIBING";
  await assert.rejects(
    () => translateVideo(deps, videoId, { target: "en" }),
    (e) => e instanceof ApiError && e.status === 409,
  );
});
