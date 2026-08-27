import { rm, stat } from "node:fs/promises";

import type { StorageProvider } from "../providers/types.ts";
import { type SourceCache, scratchPath } from "./deps.ts";

export interface FsSourceCacheOptions {
  storage: StorageProvider;
  tempDir: string;
}

/**
 * Keeps one copy of each video's source under `<tempDir>/videos/<id>/source`.
 * PROBE downloads it; EXTRACT_AUDIO, THUMBNAIL and RENDER reuse it. THUMBNAIL
 * (the last ingest step) evicts it; RENDER re-fetches on demand if it's gone.
 */
export class FsSourceCache implements SourceCache {
  private readonly storage: StorageProvider;
  private readonly tempDir: string;

  constructor(opts: FsSourceCacheOptions) {
    this.storage = opts.storage;
    this.tempDir = opts.tempDir;
  }

  localPath(videoId: string): string {
    return scratchPath(this.tempDir, "videos", videoId, "source");
  }

  async ensureLocal(videoId: string, storageKey: string): Promise<string> {
    const path = this.localPath(videoId);
    try {
      if ((await stat(path)).size > 0) return path;
    } catch {
      // not cached yet
    }
    await this.storage.getToFile(storageKey, path);
    return path;
  }

  async evict(videoId: string): Promise<void> {
    // Best effort: a concurrent job may still hold the file open (Windows EBUSY);
    // it will be re-fetched on demand and re-evicted later.
    try {
      await rm(scratchPath(this.tempDir, "videos", videoId), { recursive: true, force: true });
    } catch {
      // leave it for the next eviction
    }
  }
}
