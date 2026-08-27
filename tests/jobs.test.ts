import test from "node:test";
import assert from "node:assert/strict";

import { backoffDelayMs, nextRunAfter } from "../src/lib/jobs/backoff.ts";
import { JobWorker } from "../src/lib/jobs/worker.ts";
import type { JobKind, JobRecord, JobStore } from "../src/lib/jobs/types.ts";

// --- backoff ---------------------------------------------------------

test("backoffDelayMs doubles per attempt and is capped", () => {
  const noJitter = { baseMs: 1000, capMs: 20_000, random: () => 0.5 }; // factor = 1
  assert.equal(backoffDelayMs(1, noJitter), 1000);
  assert.equal(backoffDelayMs(2, noJitter), 2000);
  assert.equal(backoffDelayMs(3, noJitter), 4000);
  assert.equal(backoffDelayMs(10, noJitter), 20_000); // capped
});

test("backoffDelayMs applies jitter within the configured band", () => {
  const lo = backoffDelayMs(3, { baseMs: 1000, jitter: 0.2, random: () => 0 });
  const hi = backoffDelayMs(3, { baseMs: 1000, jitter: 0.2, random: () => 1 });
  assert.equal(lo, 3200); // 4000 * 0.8
  assert.equal(hi, 4800); // 4000 * 1.2
});

test("nextRunAfter returns a Date offset from the injected clock", () => {
  const at = nextRunAfter(1, { baseMs: 5000, random: () => 0.5, now: () => 1_000_000 });
  assert.equal(at.getTime(), 1_005_000);
});

// --- in-memory JobStore --------------------------------------------

interface Row extends JobRecord {
  result?: unknown;
  errorMessage?: string | null;
}

class MemoryStore implements JobStore {
  rows = new Map<string, Row>();

  add(partial: Partial<Row> & { id: string; kind: JobKind }): void {
    this.rows.set(partial.id, {
      videoId: "v1",
      status: "QUEUED",
      attempts: 0,
      maxAttempts: 3,
      progress: 0,
      payload: null,
      runAfter: new Date(0),
      ...partial,
    });
  }

  async claimable(now: Date, limit: number): Promise<JobRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.status === "QUEUED" && r.runAfter.getTime() <= now.getTime())
      .sort((a, b) => a.runAfter.getTime() - b.runAfter.getTime())
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async claim(id: string): Promise<JobRecord | null> {
    const r = this.rows.get(id);
    if (!r || r.status !== "QUEUED") return null;
    r.status = "PROCESSING";
    r.attempts += 1;
    r.progress = 0;
    return { ...r };
  }

  async complete(id: string, result: unknown): Promise<void> {
    const r = this.rows.get(id)!;
    r.status = "COMPLETED";
    r.progress = 1;
    r.result = result;
    r.errorMessage = null;
  }

  async fail(id: string, errorMessage: string): Promise<void> {
    const r = this.rows.get(id)!;
    r.status = "FAILED";
    r.errorMessage = errorMessage;
  }

  async retry(id: string, runAfter: Date): Promise<void> {
    const r = this.rows.get(id)!;
    r.status = "QUEUED";
    r.runAfter = runAfter;
  }

  async setProgress(id: string, fraction: number): Promise<void> {
    this.rows.get(id)!.progress = fraction;
  }
}

const deps = { tag: "test" };

// --- worker.runOnce ----------------------------------------------

test("runOnce claims a job, runs its handler, and stores the result", async () => {
  const store = new MemoryStore();
  store.add({ id: "j1", kind: "PROBE" });

  const worker = new JobWorker({
    store,
    deps,
    handlers: {
      PROBE: async (ctx) => {
        await ctx.setProgress(0.5);
        return { width: 1920 };
      },
    },
  });

  assert.equal(await worker.runOnce(), 1);
  const row = store.rows.get("j1")!;
  assert.equal(row.status, "COMPLETED");
  assert.equal(row.progress, 1);
  assert.deepEqual(row.result, { width: 1920 });
  assert.equal(row.attempts, 1);
});

test("a job with no registered handler is failed", async () => {
  const store = new MemoryStore();
  store.add({ id: "j1", kind: "RENDER" });
  const worker = new JobWorker({ store, deps, handlers: {} });

  await worker.runOnce();
  const row = store.rows.get("j1")!;
  assert.equal(row.status, "FAILED");
  assert.match(row.errorMessage!, /no handler registered for job kind RENDER/);
});

test("a throwing handler is retried with a future runAfter until maxAttempts", async () => {
  const store = new MemoryStore();
  store.add({ id: "j1", kind: "TRANSCRIBE", maxAttempts: 2 });
  const worker = new JobWorker({
    store,
    deps,
    handlers: { TRANSCRIBE: async () => { throw new Error("boom"); } },
    backoff: { baseMs: 1000, random: () => 0.5, now: () => 10_000 },
  });

  await worker.runOnce(); // attempt 1 -> requeued
  let row = store.rows.get("j1")!;
  assert.equal(row.status, "QUEUED");
  assert.equal(row.attempts, 1);
  assert.equal(row.runAfter.getTime(), 11_000);

  row.runAfter = new Date(0); // make it claimable again
  await worker.runOnce(); // attempt 2 -> maxAttempts reached -> FAILED
  row = store.rows.get("j1")!;
  assert.equal(row.status, "FAILED");
  assert.equal(row.attempts, 2);
  assert.equal(row.errorMessage, "boom");
});

test("runOnce processes at most `concurrency` jobs per batch", async () => {
  const store = new MemoryStore();
  for (const id of ["a", "b", "c"]) store.add({ id, kind: "THUMBNAIL" });

  let active = 0;
  let peak = 0;
  const worker = new JobWorker({
    store,
    deps,
    concurrency: 2,
    handlers: {
      THUMBNAIL: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      },
    },
  });

  assert.equal(await worker.runOnce(), 2);
  assert.ok(peak <= 2);
  const statuses = [...store.rows.values()].map((r) => r.status).sort();
  assert.deepEqual(statuses, ["COMPLETED", "COMPLETED", "QUEUED"]);
});

test("start() drains the queue and stop() halts the loop", async () => {
  const store = new MemoryStore();
  for (const id of ["a", "b", "c"]) store.add({ id, kind: "ANALYZE" });

  const worker = new JobWorker({
    store,
    deps,
    concurrency: 2,
    pollIntervalMs: 5,
    handlers: { ANALYZE: async () => ({ ok: true }) },
  });

  worker.start();
  await new Promise((r) => setTimeout(r, 40));
  await worker.stop();

  assert.ok([...store.rows.values()].every((r) => r.status === "COMPLETED"));
});

test("a job aborted by shutdown is requeued without spending an attempt", async () => {
  const store = new MemoryStore();
  store.add({ id: "j1", kind: "RENDER" });

  const worker = new JobWorker({
    store,
    deps,
    handlers: {
      RENDER: async (ctx) => {
        await new Promise((resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
    },
    now: () => 50_000,
  });

  worker.start();
  await new Promise((r) => setTimeout(r, 10));
  await worker.stop();

  const row = store.rows.get("j1")!;
  assert.equal(row.status, "QUEUED");
  assert.equal(row.attempts, 1); // the claim bumped it once; the abort didn't add another
  assert.equal(row.runAfter.getTime(), 50_000);
});
