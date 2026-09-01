import fs from "node:fs/promises";
import path from "node:path";

/**
 * Finding files in the media store that nothing owns any more.
 *
 * Two rules, both learned the hard way. A file is referenced when its exact key
 * appears in the database — but several kinds of key are *derived by
 * convention* rather than stored (`videos/<id>/audio.wav`, `poster.jpg`,
 * `clips/<id>/thumb.jpg`, voiceover takes, live chunks), so key-matching alone
 * flags files the app will read back tomorrow. The ownership rule closes that:
 * a file only counts as an orphan when the entity named in its path no longer
 * exists. Wrong the other way, this deletes someone's media library — the
 * first draft of this scan flagged all 135 files in a real store.
 */
export interface OrphanScanInput {
  /** Every storage key the database references directly. */
  referencedKeys: ReadonlySet<string>;
  /** Live entity ids, by the top-level folder their files live under. */
  liveIds: {
    videos: ReadonlySet<string>;
    clips: ReadonlySet<string>;
    voiceovers: ReadonlySet<string>;
    renders: ReadonlySet<string>;
  };
}

/** Pure: is this relative key (posix-style) safe to delete? Exported for tests. */
export function isOrphan(key: string, input: OrphanScanInput): boolean {
  if (input.referencedKeys.has(key)) return false;
  const [folder, owner] = key.split("/");
  switch (folder) {
    case "videos":
      return !input.liveIds.videos.has(owner);
    case "clips":
      return !input.liveIds.clips.has(owner);
    case "voiceovers":
      return !input.liveIds.voiceovers.has(owner);
    case "renders":
      return !input.liveIds.renders.has(owner);
    default:
      // Unknown layout (assets/, future folders): never guess with deletion.
      return false;
  }
}

export interface StorageReport {
  totalBytes: number;
  fileCount: number;
  orphanBytes: number;
  orphanCount: number;
  orphans: string[];
}

/** Walk the store and report usage plus what a cleanup would remove. */
export async function scanStorage(rootDir: string, input: OrphanScanInput): Promise<StorageReport> {
  let totalBytes = 0;
  let fileCount = 0;
  const orphans: string[] = [];
  let orphanBytes = 0;

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
        continue;
      }
      const stat = await fs.stat(full).catch(() => null);
      if (!stat) continue;
      totalBytes += stat.size;
      fileCount += 1;
      const key = path.relative(rootDir, full).split(path.sep).join("/");
      if (isOrphan(key, input)) {
        orphans.push(key);
        orphanBytes += stat.size;
      }
    }
  };

  await walk(rootDir);
  return { totalBytes, fileCount, orphanBytes, orphanCount: orphans.length, orphans };
}

/** Delete the given keys and prune the directories they leave empty. */
export async function deleteOrphans(rootDir: string, keys: readonly string[]): Promise<number> {
  let removed = 0;
  for (const key of keys) {
    // The scan produced these keys, but re-check before rm: the store may have
    // changed since, and deletion is the one direction with no undo.
    const full = path.join(rootDir, ...key.split("/"));
    if (!full.startsWith(path.resolve(rootDir))) continue;
    try {
      await fs.rm(full);
      removed += 1;
    } catch {
      /* already gone or locked — skip, never force */
    }
  }
  // Sweep empty directories bottom-up so the store does not accumulate husks.
  const pruneEmpty = async (dir: string): Promise<boolean> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (e.isDirectory()) await pruneEmpty(path.join(dir, e.name));
    }
    entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    if (entries.length === 0 && path.resolve(dir) !== path.resolve(rootDir)) {
      await fs.rmdir(dir).catch(() => {});
      return true;
    }
    return false;
  };
  await pruneEmpty(rootDir);
  return removed;
}
