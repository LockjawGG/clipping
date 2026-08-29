import { rm } from "node:fs/promises";

import { env } from "../env.ts";
import { db } from "../db.ts";
import { JobWorker } from "../jobs/worker.ts";
import { createPrismaJobStore } from "../jobs/prisma-store.ts";
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
    // A job that's out of retries leaves its video terminal, so it stops showing
    // as "processing" forever. "Retry processing" can still requeue it.
    onJobFailed: async (job, message) => {
      await db.video
        .update({
          where: { id: job.videoId },
          data: { status: "FAILED", errorMessage: message.slice(0, 2000) },
        })
        .catch(() => {});
    },
  });
}
