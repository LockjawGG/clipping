import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";

import type { StorageProvider } from "../src/lib/providers/types.ts";
import type { VideoDb, VideoRecord, VideoServiceDeps } from "../src/lib/api/videos.ts";
import {
  confirmUpload,
  createUploadSchema,
  createVideoFromUrl,
  createVideoUpload,
  getVideoStatus,
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
  const videos = new Map<string, VideoRecord & { projectId: string }>();
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
        });
        return { id };
      },
      async findUnique({ where }) {
        return videos.get(where.id) ?? null;
      },
      async update({ where, data }) {
        Object.assign(videos.get(where.id)!, data);
        return {};
      },
    },
    clip: { count: async () => 3 },
    transcript: { findUnique: async () => ({ language: "en" }) },
    job: {
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
  };
  return { db, videos };
}

function makeDeps(over: Partial<VideoServiceDeps> = {}): {
  deps: VideoServiceDeps;
  enqueued: Array<{ videoId: string; kind: string; payload?: unknown }>;
  videos: ReturnType<typeof fakeDb>["videos"];
} {
  const { db, videos } = fakeDb();
  const enqueued: Array<{ videoId: string; kind: string; payload?: unknown }> = [];
  const deps: VideoServiceDeps = {
    db,
    storage: fakeStorage(),
    maxUploadBytes: 5_000_000,
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
  return { deps, enqueued, videos };
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

test("createVideoFromUrl rejects non-URLs and non-http schemes", async () => {
  const { deps } = makeDeps();
  await assert.rejects(() => createVideoFromUrl(deps, { url: "not a url" }));
  await assert.rejects(() => createVideoFromUrl(deps, { url: "ftp://example.com/x.mp4" }));
  await assert.rejects(() => createVideoFromUrl(deps, {}));
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
