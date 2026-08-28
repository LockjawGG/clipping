import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sweepTempDir, type TempSweepDb } from "../src/lib/pipeline/temp-sweep.ts";

const HOUR = 3600_000;

/** Make `<root>/<sub>/<id>/f` with a byte and backdate its mtime `agoMs`. */
async function seed(root: string, sub: string, id: string, agoMs: number, bytes = 10) {
  const dir = join(root, sub, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "source"), Buffer.alloc(bytes));
  const t = new Date(Date.now() - agoMs);
  await utimes(dir, t, t);
}
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

function fakeDb(videos: Record<string, string>, jobs: Record<string, string>): TempSweepDb {
  return {
    video: {
      findMany: async ({ where }) =>
        where.id.in.filter((id) => id in videos).map((id) => ({ id, status: videos[id] })),
    },
    job: {
      findMany: async ({ where }) =>
        where.id.in.filter((id) => id in jobs).map((id) => ({ id, status: jobs[id] })),
    },
  };
}

test("sweepTempDir removes orphaned and terminal dirs, spares in-flight and recent ones", async () => {
  const root = await mkdtemp(join(tmpdir(), "sweep-"));
  try {
    await seed(root, "videos", "v-orphan-old", 10 * HOUR); // no row  -> remove
    await seed(root, "videos", "v-ready-old", 10 * HOUR); // READY    -> remove
    await seed(root, "videos", "v-probing", 10 * HOUR); //  PROBING  -> keep
    await seed(root, "videos", "v-orphan-fresh", 1 * HOUR); // no row but recent -> keep
    await seed(root, "jobs", "j-done", 10 * HOUR); //         COMPLETED -> remove
    await seed(root, "jobs", "j-running", 10 * HOUR); //      PROCESSING -> keep
    await seed(root, "jobs", "j-orphan", 10 * HOUR); //       no row    -> remove

    const db = fakeDb(
      { "v-ready-old": "READY", "v-probing": "PROBING" },
      { "j-done": "COMPLETED", "j-running": "PROCESSING" },
    );

    const res = await sweepTempDir({ tempDir: root, db, minAgeMs: 6 * HOUR });

    const slash = (p: string) => p.replace(/\\/g, "/");
    const gone = res.removed.map((p) => slash(p).replace(slash(root) + "/", ""));
    assert.deepEqual(
      gone.sort(),
      ["jobs/j-done", "jobs/j-orphan", "videos/v-orphan-old", "videos/v-ready-old"].sort(),
    );
    assert.ok(res.bytesFreed >= 40);

    assert.equal(await exists(join(root, "videos", "v-probing")), true);
    assert.equal(await exists(join(root, "videos", "v-orphan-fresh")), true);
    assert.equal(await exists(join(root, "jobs", "j-running")), true);
    assert.equal(await exists(join(root, "videos", "v-orphan-old")), false);
    assert.equal(await exists(join(root, "jobs", "j-done")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sweepTempDir is a no-op when TEMP_DIR has no videos/ or jobs/ subdirs", async () => {
  const root = await mkdtemp(join(tmpdir(), "sweep-empty-"));
  try {
    const res = await sweepTempDir({ tempDir: root, db: fakeDb({}, {}) });
    assert.deepEqual(res, { removed: [], bytesFreed: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sweepTempDir spares everything younger than minAgeMs", async () => {
  const root = await mkdtemp(join(tmpdir(), "sweep-young-"));
  try {
    await seed(root, "videos", "v1", 2 * HOUR); // orphan but recent
    await seed(root, "jobs", "j1", 30 * 60_000);
    const res = await sweepTempDir({ tempDir: root, db: fakeDb({}, {}), minAgeMs: 6 * HOUR });
    assert.equal(res.removed.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
