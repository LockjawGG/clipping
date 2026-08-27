import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { StorageProvider } from "../src/lib/providers/types.ts";
import { FsSourceCache } from "../src/lib/pipeline/source-cache.ts";

function fakeStorage(onGet: (key: string, dest: string) => Promise<void>): StorageProvider {
  return {
    name: "fake",
    getToFile: onGet,
    putFile: async () => {},
    createUploadUrl: async () => "",
    createDownloadUrl: async () => "",
    delete: async () => {},
    exists: async () => true,
  } as unknown as StorageProvider;
}

test("ensureLocal downloads once, then serves the cached copy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "src-cache-"));
  try {
    let downloads = 0;
    const storage = fakeStorage(async (_key, dest) => {
      downloads++;
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, "video-bytes");
    });
    const cache = new FsSourceCache({ storage, tempDir: dir });

    const p1 = await cache.ensureLocal("vidA", "videos/vidA/source.mp4");
    const p2 = await cache.ensureLocal("vidA", "videos/vidA/source.mp4");

    assert.equal(p1, cache.localPath("vidA"));
    assert.equal(p2, p1);
    assert.equal(downloads, 1); // second call was a cache hit
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureLocal re-downloads when the cached file is missing or empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "src-cache-"));
  try {
    let downloads = 0;
    const storage = fakeStorage(async (_key, dest) => {
      downloads++;
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, "video-bytes");
    });
    const cache = new FsSourceCache({ storage, tempDir: dir });

    await cache.ensureLocal("vidA", "videos/vidA/source.mp4");
    await writeFile(cache.localPath("vidA"), ""); // truncate to zero bytes
    await cache.ensureLocal("vidA", "videos/vidA/source.mp4");

    assert.equal(downloads, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("evict removes the whole per-video directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "src-cache-"));
  try {
    const storage = fakeStorage(async (_key, dest) => {
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, "video-bytes");
    });
    const cache = new FsSourceCache({ storage, tempDir: dir });

    const path = await cache.ensureLocal("vidA", "videos/vidA/source.mp4");
    await cache.evict("vidA");

    await assert.rejects(() => stat(path));
    await cache.evict("vidA"); // idempotent — no throw on a second call
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
