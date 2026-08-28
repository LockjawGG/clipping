import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Housekeeping for `TEMP_DIR`. Downloaded sources live at
 * `<TEMP_DIR>/videos/<videoId>/…` and per-job scratch at
 * `<TEMP_DIR>/jobs/<jobId>/…`. On the happy path both are cleaned up
 * (THUMBNAIL evicts the source; the worker wipes job scratch). A crash or a
 * kill mid-ingest leaves orphans behind — this removes them.
 *
 * Never touches `LOCAL_STORAGE_DIR` (permanent project media) — only `TEMP_DIR`.
 */

export interface TempSweepDb {
  video: {
    findMany(a: {
      where: { id: { in: string[] } };
      select: { id: true; status: true };
    }): Promise<Array<{ id: string; status: string }>>;
  };
  job: {
    findMany(a: {
      where: { id: { in: string[] } };
      select: { id: true; status: true };
    }): Promise<Array<{ id: string; status: string }>>;
  };
}

export interface SweepOptions {
  tempDir: string;
  db: TempSweepDb;
  /** Spare anything touched more recently than this (in-flight work). Default 6h. */
  minAgeMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

/** Video states whose downloaded source is still needed mid-ingest. */
const VIDEO_IN_FLIGHT = new Set(["UPLOADING", "UPLOADED", "PROBING", "TRANSCRIBING"]);
/** Job states whose scratch dir is still in use. */
const JOB_IN_FLIGHT = new Set(["QUEUED", "PROCESSING"]);

async function dirSize(path: string): Promise<number> {
  let total = 0;
  try {
    for (const e of await readdir(path, { withFileTypes: true })) {
      const child = join(path, e.name);
      if (e.isDirectory()) total += await dirSize(child);
      else {
        try {
          total += (await stat(child)).size;
        } catch {
          /* vanished */
        }
      }
    }
  } catch {
    /* vanished */
  }
  return total;
}

/**
 * Remove `<TEMP_DIR>/videos/<id>` and `<TEMP_DIR>/jobs/<id>` dirs whose row is
 * gone or in a terminal state, and which haven't been touched for `minAgeMs`.
 */
export async function sweepTempDir(opts: SweepOptions): Promise<{
  removed: string[];
  bytesFreed: number;
}> {
  const now = opts.now?.() ?? Date.now();
  const minAge = opts.minAgeMs ?? 6 * 60 * 60_000;
  const removed: string[] = [];
  let bytesFreed = 0;

  for (const [sub, kind] of [
    ["videos", "video"],
    ["jobs", "job"],
  ] as const) {
    const base = join(opts.tempDir, sub);
    let ids: string[];
    try {
      ids = (await readdir(base, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue; // dir doesn't exist yet
    }
    if (ids.length === 0) continue;

    const rows =
      kind === "video"
        ? await opts.db.video.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } })
        : await opts.db.job.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } });
    const statusById = new Map(rows.map((r) => [r.id, r.status]));
    const inFlight = kind === "video" ? VIDEO_IN_FLIGHT : JOB_IN_FLIGHT;

    for (const id of ids) {
      const path = join(base, id);
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(path)).mtimeMs;
      } catch {
        continue;
      }
      if (now - mtimeMs < minAge) continue; // recent — leave in-flight work alone

      const status = statusById.get(id);
      if (status !== undefined && inFlight.has(status)) continue;

      const bytes = await dirSize(path);
      await rm(path, { recursive: true, force: true }).catch(() => {});
      removed.push(path);
      bytesFreed += bytes;
    }
  }

  if (removed.length) {
    opts.log?.(`swept ${removed.length} orphaned temp dir(s), ~${Math.round(bytesFreed / 1e6)} MB`);
  }
  return { removed, bytesFreed };
}

/**
 * Run the sweep once now, then on an interval. Returns a stop function.
 * Errors are logged, never thrown — housekeeping must not crash the worker.
 */
export function startTempSweep(opts: {
  tempDir: string;
  db: TempSweepDb;
  intervalMs?: number;
}): () => void {
  const run = () =>
    sweepTempDir({
      tempDir: opts.tempDir,
      db: opts.db,
      log: (m) => console.log(`[worker] ${m}`),
    }).catch((e) => console.error(`[worker] temp sweep failed: ${e}`));

  void run();
  const timer = setInterval(run, opts.intervalMs ?? 60 * 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
