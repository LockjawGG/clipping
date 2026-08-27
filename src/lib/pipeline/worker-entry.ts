import { env } from "../env.ts";
import { db } from "../db.ts";
import { JobWorker } from "../jobs/worker.ts";
import { createPrismaJobStore } from "../jobs/prisma-store.ts";
import type { PipelineDeps } from "./deps.ts";
import { PIPELINE_HANDLERS } from "./index.ts";
import { buildPipelineDeps } from "./repos.ts";

/** The configured ingest worker: Prisma-backed queue + the pipeline handlers. */
export function createPipelineWorker(): JobWorker<PipelineDeps> {
  return new JobWorker<PipelineDeps>({
    store: createPrismaJobStore(db),
    deps: buildPipelineDeps(),
    handlers: PIPELINE_HANDLERS,
    concurrency: env.WORKER_CONCURRENCY,
    onError: (job, err) => {
      console.error(`[worker] job ${job.id} (${job.kind}) failed:`, err);
    },
  });
}
