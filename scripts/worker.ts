/**
 * Long-running ingest worker. Run alongside `next start`:
 *
 *   npm run worker
 */
import { createPipelineWorker } from "../src/lib/pipeline/worker-entry.ts";

const worker = createPipelineWorker();
worker.start();
console.log("[worker] started; polling the job queue");

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(`[worker] ${signal} received, draining…`);
    worker.stop().then(() => {
      console.log("[worker] stopped");
      process.exit(0);
    });
  });
}
