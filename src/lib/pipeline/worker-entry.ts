import { rm } from "node:fs/promises";

import { env } from "../env.ts";
import { db } from "../db.ts";
import { JobWorker } from "../jobs/worker.ts";
import { createPrismaJobStore } from "../jobs/prisma-store.ts";
import { emitTelemetry } from "../telemetry/emit.ts";
import type { TelemetryDb } from "../telemetry/types.ts";
import { jobWorkDir, type PipelineDeps } from "./deps.ts";
import { PIPELINE_HANDLERS } from "./index.ts";
import { buildPipelineDeps } from "./repos.ts";

/** The configured ingest worker: Prisma-backed queue + the pipeline handlers. */
export function createPipelineWorker(): JobWorker<PipelineDeps> {
  return new JobWorker<PipelineDeps>({
    store: createPrismaJobStore(db),
    deps: buildPipelineDeps(),
    handlers: PIPELINE_HANDLERS,
    concurrency: env.WORKER_CONCURRENCY,
    // CPU-bound steps (whisper) can pin every core and starve this process's
    // heartbeat timer, so give a job a long grace window before it's reclaimed.
    leaseMs: 15 * 60_000,
    heartbeatMs: 20_000,
    // Wipe the job's scratch dir once it's done, whatever the outcome.
    cleanup: (job) => rm(jobWorkDir(env.TEMP_DIR, job.id), { recursive: true, force: true }),
    onError: (job, err) => {
      console.error(`[worker] ${job.id === "-" ? "" : `job ${job.id} (${job.kind}) `}${err}`);
    },
    // Feed the Agent Brain page. This process already holds a Prisma client
    // (the `db` imported above); reusing it keeps the worker on one connection
    // pool. Not awaited — recording a job must never pace the job.
    onJobEvent: (event) => {
      void emitTelemetry(db as unknown as TelemetryDb, {
        source: "clipper",
        eventType:
          event.phase === "started"
            ? "task.started"
            : event.phase === "completed"
              ? "task.completed"
              : "task.failed",
        actor: `job:${event.job.kind}`,
        taskId: event.job.id,
        status: event.status,
        latencyMs: event.latencyMs,
        // An id prefix is enough to line a row up with the dashboard, without
        // putting a full identifier on a screen left open on a second monitor.
        summary: `${event.job.kind} for video ${event.job.videoId.slice(0, 8)}`,
        meta: { attempt: event.job.attempts },
      });
    },
    // An ingest job that's out of retries leaves its video FAILED so it stops
    // showing as "processing" forever ("Retry processing" can still requeue it).
    // RENDER / THUMBNAIL failures don't touch the video — a broken export or a
    // missing poster must not knock a fully-transcribed video offline.
    onJobFailed: async (job, message) => {
      const INGEST = new Set([
        "FETCH",
        "PROBE",
        "EXTRACT_AUDIO",
        "TRANSCRIBE",
        "ANALYZE",
        "LIVE_FINALIZE",
      ]);
      if (!INGEST.has(job.kind)) return;
      await db.video
        .updateMany({
          where: { id: job.videoId, status: { not: "READY" } },
          data: { status: "FAILED", errorMessage: message.slice(0, 2000) },
        })
        .catch(() => {});
    },
  });
}
