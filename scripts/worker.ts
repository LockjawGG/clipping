/**
 * Long-running ingest worker. Run alongside `next start`:
 *
 *   npm run worker
 */
import { db } from "../src/lib/db.ts";
import { env } from "../src/lib/env.ts";
import { enqueueJob } from "../src/lib/jobs/prisma-store.ts";
import { createPipelineWorker } from "../src/lib/pipeline/worker-entry.ts";
import { type LiveSweepDb, startLiveSweep } from "../src/lib/pipeline/live-sweep.ts";
import { startTempSweep } from "../src/lib/pipeline/temp-sweep.ts";

const worker = createPipelineWorker();
worker.start();
const stopSweep = startTempSweep({ tempDir: env.TEMP_DIR, db });
const stopLiveSweep = startLiveSweep({
  // Same narrowing the service layer uses: the sweep declares only the handful
  // of Prisma calls it makes rather than depending on the generated client.
  db: db as unknown as LiveSweepDb,
  enqueue: (input) => enqueueJob(db, input),
});
console.log("[worker] started; polling the job queue");

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(`[worker] ${signal} received, draining…`);
    stopSweep();
    stopLiveSweep();
    worker.stop().then(() => {
      console.log("[worker] stopped");
      process.exit(0);
    });
  });
}
